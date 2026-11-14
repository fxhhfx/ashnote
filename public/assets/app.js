import { encryptWithLink, encryptWithPass } from "./crypto.js";

const $ = (id) => document.getElementById(id);

let ttl = 86400;

/* ---------------- 有效期选择 ---------------- */
$("ttl-chips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn || !btn.dataset.ttl) return;
  document.querySelectorAll("#ttl-chips .chip").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
  ttl = Number(btn.dataset.ttl);
});

/* ---------------- 口令开关 ---------------- */
$("use-pass").addEventListener("change", (e) => {
  $("pass-box").style.display = e.target.checked ? "block" : "none";
  if (e.target.checked) $("passphrase").focus();
});

/* ---------------- 提示 ---------------- */
function showError(text) {
  const el = $("err-msg");
  el.textContent = text;
  el.classList.add("show");
}

function clearError() {
  $("err-msg").classList.remove("show");
}

/* ---------------- 创建 ---------------- */
$("create-btn").addEventListener("click", async () => {
  clearError();
  const text = $("content").value;

  if (!text.trim()) {
    showError("内容不能为空。");
    return;
  }
  if (new TextEncoder().encode(text).length > 100 * 1024) {
    showError("内容太长了，请控制在 100KB 以内。");
    return;
  }

  const usePass = $("use-pass").checked;
  const passphrase = $("passphrase").value;

  if (usePass && passphrase.length < 6) {
    showError("口令至少 6 位。");
    return;
  }

  const btn = $("create-btn");
  btn.disabled = true;
  btn.textContent = "正在加密…";

  try {
    const { payload, fragment } = usePass
      ? await encryptWithPass(text, passphrase)
      : await encryptWithLink(text);

    btn.textContent = "正在写入边缘节点…";

    const resp = await fetch("/api/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ct: payload.ct, iv: payload.iv, mode: payload.mode, ttl }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error === "too_large" ? "内容超出服务端限制。" : "写入失败，请稍后再试。");
    }

    const data = await resp.json();
    const origin = location.origin;

    const shareParams = new URLSearchParams({ i: data.id, ...fragment });
    const shareUrl = `${origin}/v/#${shareParams.toString()}`;

    const mgmtParams = new URLSearchParams({ i: data.id, t: data.mgmt });
    const mgmtUrl = `${origin}/s/#${mgmtParams.toString()}`;

    $("share-link").value = shareUrl;
    $("mgmt-link").value = mgmtUrl;
    $("share-hint").textContent = usePass
      ? "打开链接后需要输入口令才能查看。口令请用另一个渠道告诉对方。"
      : "打开即看，看完即焚，只能看一次。";

    $("result").classList.add("show");
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });

    $("content").value = "";
    $("passphrase").value = "";
    loadStats();
  } catch (e) {
    showError(e.message || "出错了，请重试。");
  } finally {
    btn.disabled = false;
    btn.textContent = "生成一次性链接";
  }
});

/* ---------------- 复制 ---------------- */
function bindCopy(btnId, inputId) {
  $(btnId).addEventListener("click", async () => {
    const input = $(inputId);
    const text = input.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      input.select();
      document.execCommand("copy");
    }
    const btn = $(btnId);
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1400);
  });
}

bindCopy("copy-share", "share-link");
bindCopy("copy-mgmt", "mgmt-link");

/* ---------------- 边缘计数 ---------------- */
async function loadStats() {
  try {
    const resp = await fetch("/api/stats");
    const data = await resp.json();
    const n = Number(data.total) || 0;
    $("stats-line").textContent = `此刻有 ${n} 条秘密正等着被读取`;
  } catch (e) {
    $("stats-line").textContent = "";
  }
}

loadStats();
