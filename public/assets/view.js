import { decryptWithLink, decryptWithPass } from "./crypto.js";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.hash.slice(1));
const id = params.get("i");
const mode = params.get("m");

function show(which) {
  ["state-loading", "state-pass", "state-content", "state-gone"].forEach((s) => {
    $(s).style.display = s === which ? "block" : "none";
  });
}

function showGone(desc) {
  show("state-gone");
  if (desc) $("gone-desc").textContent = desc;
  const stage = $("stage");
  if (stage) stage.style.opacity = "0.35";
}

function goneText(state) {
  if (state === "read") return "这条笔记已经被读过了，内容已销毁。";
  if (state === "expired") return "这条笔记已经超过有效期，被自动销毁了。";
  return "找不到这条笔记，可能已被读取或发送方提前销毁。";
}

/** 取回密文，非 ok 状态直接切到“已焚毁”并返回 null */
async function takeCipher() {
  let data;
  try {
    const resp = await fetch("/api/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    data = await resp.json();
  } catch (e) {
    showGone("网络异常，没能取回密文，请稍后重试。");
    return null;
  }
  if (data.state !== "ok") {
    showGone(goneText(data.state));
    return null;
  }
  return data;
}

async function burn() {
  try {
    await fetch("/api/burn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (e) {
    /* 焚毁失败不影响已展示的内容 */
  }
}

function renderContent(text, stateText) {
  show("state-content");
  $("secret").textContent = text;
  $("burn-state").textContent = stateText;

  $("copy-secret").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const btn = $("copy-secret");
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = "复制内容"), 1400);
  });
}

/* ---------------- 链接模式 ---------------- */

async function startLinkMode() {
  const key = params.get("k");
  if (!key) {
    showGone("链接里缺少解密密钥，请让发送方重新发一次完整链接。");
    return;
  }

  show("state-loading");
  const data = await takeCipher();
  if (!data) return;

  try {
    const text = await decryptWithLink(data.ct, data.iv, key);
    renderContent(text, "已在边缘节点销毁");
  } catch (e) {
    showGone("解密失败：链接可能被改动过，或者内容已损坏。");
  }
}

/* ---------------- 口令模式 ---------------- */

async function unlock() {
  const err = $("pass-err");
  err.classList.remove("show");

  const passphrase = $("passphrase").value;
  if (!passphrase) {
    err.textContent = "请输入口令。";
    err.classList.add("show");
    return;
  }

  const salt = params.get("s");
  if (!salt) {
    showGone("链接里缺少必要参数，请让发送方重新发一次完整链接。");
    return;
  }

  const btn = $("unlock-btn");
  btn.disabled = true;
  btn.textContent = "正在解锁…";

  try {
    const data = await takeCipher();
    if (!data) return;

    let text;
    try {
      text = await decryptWithPass(data.ct, data.iv, salt, passphrase);
    } catch (e) {
      err.textContent = "口令不对，再试一次。";
      err.classList.add("show");
      return;
    }

    // 解密成功才焚毁，避免口令输错把内容白白烧掉
    renderContent(text, "解密成功，正在销毁…");
    await burn();
    $("burn-state").textContent = "已在边缘节点销毁";
  } finally {
    btn.disabled = false;
    btn.textContent = "解锁";
  }
}

/* ---------------- 入口 ---------------- */

function start() {
  if (!id || !mode) {
    showGone("链接不完整，可能是复制时丢了一段。请让发送方重新发一次完整链接。");
    return;
  }

  if (mode === "pass") {
    show("state-pass");
    $("passphrase").focus();
    $("unlock-btn").addEventListener("click", unlock);
    $("passphrase").addEventListener("keydown", (e) => {
      if (e.key === "Enter") unlock();
    });
    return;
  }

  startLinkMode();
}

start();
