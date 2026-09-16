import { createHash } from "node:crypto";
import { Tokenizer, TokenParser, TokenType } from "@streamparser/json";
import { ApiError, fail, object } from "./http";

// This is D1's platform string/row ceiling, not an additional application content limit.
const D1_VALUE_BYTES = 2_000_000;
const encoder = new TextEncoder();
class LosslessTokenizer extends Tokenizer {
  numberText = "";
  protected override parseNumber(text: string): number {
    this.numberText = text;
    return Number(text);
  }
}
type Frame = {
  path: (string | number)[];
  keys?: Set<string>;
  key?: string;
  expectKey: boolean;
  index: number;
};
export async function readBody(request: Request): Promise<{
  body: Record<string, unknown>;
  hash: string;
  contents: Map<number, string>;
}> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(
      request.headers.get("Content-Type") ?? "",
    )
  )
    fail("UNSUPPORTED_MEDIA_TYPE", 415);
  if (!request.body) fail();
  const tokenizer = new LosslessTokenizer({
    emitPartialTokens: true,
    stringBufferSize: 65536,
  });
  const parser = new TokenParser();
  const contents = new Map<number, string>();
  let contentTokens: string[] = [];
  const frames: Frame[] = [];
  let root: unknown, contentBytes: number | undefined;
  tokenizer.onToken = (info) => {
    const { token, value, partial } = info;
    const length = encoder.encode(JSON.stringify(value)).length;
    if (
      length > D1_VALUE_BYTES ||
      (contentBytes !== undefined && contentBytes + length > D1_VALUE_BYTES)
    )
      fail("PAYLOAD_TOO_LARGE", 413);
    if (partial) return;

    const parent = frames.at(-1);
    const isKey =
      !!parent?.keys && parent.expectKey && token === TokenType.STRING;
    if (isKey) {
      const key = String(value);
      if (parent.keys!.has(key)) fail();
      parent.keys!.add(key);
      parent.key = key;
      parent.expectKey = false;
    }
    const path = parent
      ? [...parent.path, parent.keys ? parent.key! : parent.index]
      : [];
    const valueToken =
      token === TokenType.LEFT_BRACE ||
      token === TokenType.LEFT_BRACKET ||
      token >= TokenType.TRUE;
    const startsContent =
      !isKey &&
      valueToken &&
      path.length === 3 &&
      path[0] === "operations" &&
      path[2] === "content";
    if (startsContent && contentBytes === undefined) {
      contentBytes = 0;
      contentTokens = [];
    }
    if (contentBytes !== undefined) {
      const text =
        token <= TokenType.COMMA
          ? String(value)
          : token === TokenType.NUMBER
            ? tokenizer.numberText
            : JSON.stringify(value);
      contentBytes += encoder.encode(text).length;
      contentTokens.push(text);
    }
    if (contentBytes !== undefined && contentBytes > D1_VALUE_BYTES)
      fail("PAYLOAD_TOO_LARGE", 413);
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      if (
        parent &&
        !parent.keys &&
        parent.path.length === 1 &&
        parent.path[0] === "operations" &&
        parent.index >= 10
      )
        fail();
      frames.push({
        path,
        keys: token === TokenType.LEFT_BRACE ? new Set() : undefined,
        expectKey: token === TokenType.LEFT_BRACE,
        index: 0,
      });
    } else if (
      token === TokenType.RIGHT_BRACE ||
      token === TokenType.RIGHT_BRACKET
    )
      frames.pop();
    else if (token === TokenType.COMMA && parent) {
      parent.expectKey = !!parent.keys;
      parent.index++;
    }
    parser.write(info);
  };
  parser.onValue = ({ value, key, stack }) => {
    if (key === "content" && stack.length === 3) {
      contents.set(Number(frames.at(-1)?.path[1]), contentTokens.join(""));
      contentTokens = [];
      contentBytes = undefined;
    }
    if (!stack.length) root = value;
  };
  const digest = createHash("sha256");
  const reader = request.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      digest.update(value);
      tokenizer.write(value);
    }
    if (!tokenizer.isEnded) tokenizer.end();
    if (!parser.isEnded) parser.end();
    return { body: object(root), hash: digest.digest("hex"), contents };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ApiError) throw error;
    fail();
  } finally {
    reader.releaseLock();
  }
}
