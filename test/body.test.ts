import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readBody } from "../src/body";
function request(text: string, chunk = 17) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Request("https://test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      pull(c) {
        if (offset === bytes.length) return c.close();
        const next = Math.min(offset + chunk, bytes.length);
        c.enqueue(bytes.slice(offset, next));
        offset = next;
      },
    }),
  });
}
it("hashes original streamed bytes and preserves unicode across chunk boundaries", async () => {
  const text =
    ' {"device_id":"a","operations":[{"content":{"文":"汉字😀","v":[null,true,false,1.5]} }]} \n';
  const result = await readBody(request(text, 1));
  expect(result.body).toEqual(JSON.parse(text));
  expect(result.hash).toBe(createHash("sha256").update(text).digest("hex"));
});
it("rejects malformed documents, repeated nested members and invalid UTF-8", async () => {
  for (const text of [
    "{}{}",
    '{"x":1,}',
    '{"x":',
    '{"x":{"a":1,"\\u0061":2}}',
    "[]",
  ]) {
    await expect(readBody(request(text))).rejects.toMatchObject({
      status: 400,
    });
  }
});
it("accepts contents larger than the old 16 KiB suggestion", async () => {
  const content = "x".repeat(100000);
  const result = await readBody(
    request(JSON.stringify({ operations: [{ content }, { content }] }), 8192),
  );
  expect(result.body.operations).toEqual([{ content }, { content }]);
});
it("rejects content beyond D1 platform storage capacity while streaming", async () => {
  await expect(
    readBody(
      request(
        JSON.stringify({ operations: [{ content: "x".repeat(2_000_001) }] }),
        65536,
      ),
    ),
  ).rejects.toMatchObject({ status: 413 });
});

it("preserves opaque JSON number lexemes without JavaScript rounding", async () => {
  const parsed = await readBody(
    request('{"operations":[{"content":{"n":9007199254740993,"huge":1e400}}]}'),
  );
  expect(parsed.contents.get(0)).toBe('{"n":9007199254740993,"huge":1e400}');
});
it("rejects invalid UTF-8 rather than replacing bytes in a key", async () => {
  const bytes = new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125]);
  const r = new Request("https://test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bytes,
  });
  await expect(readBody(r)).rejects.toMatchObject({ status: 400 });
});
