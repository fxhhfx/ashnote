const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.hash.slice(1));
const id = params.get("i");
const token = params.get("t");

function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function humanRemain(ms) {
  if (ms <= 0) return "已过期";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function showError(text) {
  $("status-card").style.display = "none";
  $("error-card").style.display = "block";
  if (text) $("error-text").textContent = text;
}

async function load() {
  if (!id || !token) {
    showError("链接不完整");
    return;
  }

  let resp, data;
  try {
    resp = await fetch("/api/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, mgmt: token }),
    });
    data = await resp.json();
  } catch (e) {
    showError("网络异常，请稍后重试");
    return;
  }

  if (!resp.ok) {
    if (resp.status === 403) return showError("管理凭证不正确");
    return showError("找不到这条笔记");
  }

  $("status-card").style.display = "block";
  $("error-card").style.display = "none";

  const stateMap = {
    unread: { text: "尚未被读取", cls: "unread" },
    read: { text: "已被读取，内容已销毁", cls: "read" },
    expired: { text: "已过期，内容已销毁", cls: "expired" },
  };
  const s = stateMap[data.state] || { text: "未知状态", cls: "expired" };

  $("state-text").textContent = s.text;
  $("dot").className = "dot " + s.cls;

  $("mode-text").textContent = data.mode === "pass" ? "AES-256-GCM + 口令派生密钥" : "AES-256-GCM + 链接密钥";
  $("created-text").textContent = fmt(data.createdAt);
  $("expires-text").textContent = fmt(data.expiresAt);
  $("read-text").textContent = data.readAt ? fmt(data.readAt) : "-";
  $("remain-text").textContent =
    data.state === "unread" ? humanRemain(data.expiresAt - Date.now()) : "-";

  const destroyBtn = $("destroy-btn");
  if (data.state !== "unread") {
    destroyBtn.disabled = true;
    destroyBtn.textContent = "内容已销毁，无需操作";
  } else {
    destroyBtn.addEventListener("click", destroy);
  }
}

async function destroy() {
  if (!confirm("确定要立刻销毁吗？对方将再也打不开这条链接。")) return;

  const btn = $("destroy-btn");
  btn.disabled = true;

  try {
    const resp = await fetch("/api/destroy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, mgmt: token }),
    });
    if (!resp.ok) throw new Error();

    $("destroy-ok").textContent = "已销毁。这条链接现在打不开了。";
    $("destroy-ok").classList.add("show");
    btn.textContent = "已销毁";
    $("state-text").textContent = "已手动销毁";
    $("dot").className = "dot read";
  } catch (e) {
    $("destroy-err").textContent = "销毁失败，请稍后重试。";
    $("destroy-err").classList.add("show");
    btn.disabled = false;
  }
}

load();
