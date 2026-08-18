(() => {
  "use strict";

  const keyField = document.querySelector("#master-key");
  const status = document.querySelector("#key-status");
  const generateButton = document.querySelector("#generate-key");
  const copyButton = document.querySelector("#copy-key");
  const deployButton = document.querySelector("#deploy-button");
  const repositoryMeta = document.querySelector('meta[name="repository-url"]');
  let masterKey = "";

  const inferRepository = () => {
    const configured = repositoryMeta?.content ?? "";
    if (configured.startsWith("https://github.com/") && !configured.includes("__REPOSITORY_URL__")) {
      return configured;
    }
    if (location.hostname.endsWith(".github.io")) {
      const owner = location.hostname.slice(0, -".github.io".length);
      const repository = location.pathname.split("/").filter(Boolean)[0];
      if (owner && repository) return `https://github.com/${owner}/${repository}`;
    }
    return "";
  };

  const repository = inferRepository();
  document.querySelectorAll("[data-repository-link]").forEach((link) => {
    if (repository) {
      link.href = repository;
      link.target = "_blank";
      link.rel = "noreferrer";
    } else {
      link.hidden = true;
    }
  });

  const clearKey = () => {
    masterKey = "";
    if (keyField) keyField.value = "";
  };
  window.addEventListener("pagehide", clearKey);
  window.addEventListener("beforeunload", clearKey);

  generateButton?.addEventListener("click", () => {
    if (!globalThis.crypto?.getRandomValues) {
      status.textContent = "当前浏览器不支持安全随机数生成，请换用现代浏览器。";
      return;
    }
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    masterKey = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    keyField.value = masterKey;
    status.textContent = "已生成 256-bit 主密钥；请立即复制并保存。";
    copyButton.disabled = false;
    deployButton.classList.remove("is-disabled");
    deployButton.setAttribute("aria-disabled", "false");
    deployButton.href = repository
      ? `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repository)}`
      : "https://deploy.workers.cloudflare.com/";
  });

  copyButton?.addEventListener("click", async () => {
    if (!masterKey) return;
    try {
      await navigator.clipboard.writeText(masterKey);
      status.textContent = "已复制。现在请保存到密码管理器。";
      copyButton.textContent = "已复制";
      setTimeout(() => { copyButton.textContent = "复制"; }, 1800);
    } catch {
      keyField.focus();
      keyField.select();
      status.textContent = "自动复制失败，密钥已选中，请手动复制。";
    }
  });

  deployButton?.addEventListener("click", (event) => {
    if (!masterKey) event.preventDefault();
  });
})();
