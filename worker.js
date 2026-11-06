/**
 * Pixiv 画师新作自动评论 —— Cloudflare Worker 版
 *
 * 每分钟跑一次，检查画师有没有新作品，有就评论。
 *
 * 需要的绑定：
 *   KV 命名空间    BINDING = STATE
 *   环境变量       PIXIV_PHPSESSID = 100541044_xxxxx   （必填）
 *   （可选）       ARTIST_IDS      = 34931308
 *   （可选）       COMMENT_TEXT    = 前排|好耶|！！！
 *   （可选）       DRY_RUN         = 1
 */

const DEFAULT_ARTISTS = "34931308";
const DEFAULT_COMMENTS = ["前排", "好耶", "！！！"];
const MAX_NEW_PER_COMMENT = 3;
const SLEEP_MS = 1500;

const HOST = "https://www.pixiv.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runOnce(env, "[cron]"));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/run") {
        return json(await runOnce(env, "[manual]"));
      }
      if (url.pathname === "/status") {
        return json(await loadState(env));
      }
      if (url.pathname === "/reset") {
        await env.STATE.delete("state");
        return new Response("state cleared\n");
      }
      return new Response(
        [
          "Pixiv auto comment worker 已运行",
          "",
          "GET /run     手动跑一次（返回 JSON）",
          "GET /status  查看状态",
          "GET /reset   清空状态",
          "",
          "定时：每分钟",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    } catch (e) {
      return new Response(`ERROR: ${e.message}\n${e.stack}`, { status: 500 });
    }
  },
};

function json(o) {
  return new Response(JSON.stringify(o, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ============ 状态（KV） ============
async function loadState(env) {
  const raw = await env.STATE.get("state");
  if (!raw) return { initialized: false, artists: {}, commentIndex: 0 };
  try {
    const s = JSON.parse(raw);
    return {
      initialized: !!s.initialized,
      artists: s.artists || {},
      commentIndex: Number(s.commentIndex || 0),
      updatedAt: s.updatedAt,
    };
  } catch {
    return { initialized: false, artists: {}, commentIndex: 0 };
  }
}

async function saveState(env, state) {
  await env.STATE.put("state", JSON.stringify(state));
}

// ============ 主流程 ============
async function runOnce(env, tag) {
  const started = Date.now();
  const log = [];
  const say = (m) => {
    console.log(`${tag} ${m}`);
    log.push(`${tag} ${m}`);
  };

  const php = (env.PIXIV_PHPSESSID || "").trim();
  if (!php) throw new Error("未设置 PIXIV_PHPSESSID");

  const artists = parseArtists(env.ARTIST_IDS || DEFAULT_ARTISTS);
  const comments = parseComments(env.COMMENT_TEXT);
  const dryRun = String(env.DRY_RUN || "").trim() === "1";

  say(`监控画师：${artists.join(", ")}；评论池：${JSON.stringify(comments)}；DRY=${dryRun}`);

  const api = new PixivClient(php);
  const me = await api.getUserInfo(api.userId);
  if (!me || me.error) throw new Error("Cookie 无效（Pixiv 会话已失效）");
  say(`登录有效：${me.body?.name || "?"} (user_id=${api.userId})`);

  const state = await loadState(env);
  const firstRun = !state.initialized;

  let commented = 0;
  let failed = 0;
  let dirty = false;

  for (const artistId of artists) {
    let works;
    try {
      works = await api.getArtistWorks(artistId);
    } catch (e) {
      say(`[ERROR] 画师 ${artistId}：${e.message}`);
      failed++;
      continue;
    }
    if (!works.length) {
      say(`画师 ${artistId}：没有作品`);
      continue;
    }

    const bucket = (state.artists[artistId] = state.artists[artistId] || { seen: [] });
    const seen = new Set(bucket.seen.map(Number));

    if (firstRun) {
      bucket.seen = works.map((w) => Number(w.id)).slice(0, 500);
      bucket.lastSeen = new Date().toISOString();
      dirty = true;
      say(`[首次运行] 画师 ${artistId}：${bucket.seen.length} 个作品标记为已见，本次不评论`);
      continue;
    }

    const fresh = works.filter((w) => !seen.has(Number(w.id)));
    if (!fresh.length) {
      say(`画师 ${artistId}：没有新作品`);
      continue;
    }

    fresh.sort((a, b) => String(a.createDate).localeCompare(String(b.createDate)));
    say(`画师 ${artistId}：发现 ${fresh.length} 个新作品 → ${fresh.map((w) => w.id).join(",")}`);

    for (const work of fresh) {
      if (commented >= MAX_NEW_PER_COMMENT) {
        say(`已达单次上限 ${MAX_NEW_PER_COMMENT}`);
        break;
      }
      const idx = Number(state.commentIndex || 0) % comments.length;
      const text = comments[idx];

      try {
        if (dryRun) {
          say(`[DRY] 跳过 illust_id=${work.id} text=${text}`);
        } else {
          const res = await api.postComment(work.id, text);
          if (res && res.error) {
            throw new Error(`Pixiv 拒绝：${JSON.stringify(res).slice(0, 200)}`);
          }
          say(`评论成功 illust_id=${work.id} text=${text} comment_id=${res?.body?.comment_id || "?"}`);
          state.commentIndex = (idx + 1) % comments.length;
          commented++;
        }
      } catch (e) {
        failed++;
        say(`[ERROR] 评论失败 illust_id=${work.id}《${work.title || ""}》：${e.message}`);
      }

      bucket.seen.push(Number(work.id));
      bucket.seen = bucket.seen.slice(-500);
      bucket.lastSeen = new Date().toISOString();
      dirty = true;

      await sleep(SLEEP_MS);
    }
  }

  if (firstRun) state.initialized = true;
  state.updatedAt = new Date().toISOString();
  if (dirty || firstRun) await saveState(env, state);

  const ms = Date.now() - started;
  say(`完成：评论 ${commented} 条，失败 ${failed} 项，耗时 ${ms}ms`);

  return { ok: true, commented, failed, ms, log };
}

// ============ 工具 ============
function parseArtists(raw) {
  return String(raw)
    .replace(/，/g, ",")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

function parseComments(raw) {
  if (!raw || !String(raw).trim()) return [...DEFAULT_COMMENTS];
  const s = String(raw);
  const parts = s.includes("\n") ? s.split("\n") : s.split("|");
  const out = parts.map((x) => x.trim()).filter(Boolean);
  return out.length ? out : [...DEFAULT_COMMENTS];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ Pixiv 客户端 ============
class PixivClient {
  constructor(phpSessionId) {
    this.php = phpSessionId;
    this.userId = phpSessionId.split("_")[0] || "0";
    this.csrf = null;
    this.cookies = { PHPSESSID: phpSessionId };
    this.warmed = false;
  }

  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  headers(extra = {}) {
    return {
      "user-agent": UA,
      accept: "application/json",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
      referer: `${HOST}/`,
      origin: HOST,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      cookie: this.cookieHeader(),
      ...extra,
    };
  }

  absorb(res) {
    try {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const first = line.split(";")[0];
        const idx = first.indexOf("=");
        if (idx > 0) {
          const k = first.slice(0, idx).trim();
          const v = first.slice(idx + 1).trim();
          if (k && !["deleted", ""].includes(v)) this.cookies[k] = v;
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  async warmup() {
    if (this.warmed) return;
    const res = await fetch(`${HOST}/`, {
      headers: this.headers({
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
      }),
      redirect: "follow",
    });
    this.absorb(res);
    await res.text();
    this.warmed = true;
  }

  async raw(path, { params, extraHeaders, method = "GET", body } = {}) {
    await this.warmup();
    const url = new URL(HOST + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
        else if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
    }
    if (!url.searchParams.has("lang")) url.searchParams.set("lang", "zh");

    const res = await fetch(url.toString(), {
      method,
      headers: this.headers(extraHeaders),
      body,
    });
    this.absorb(res);
    return res;
  }

  async json(path, params) {
    const res = await this.raw(path, { params });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      const hint =
        res.status === 403
          ? "（被 pixiv 反爬拦截，Cookie 可能失效或需要重新登录）"
          : "";
      throw new Error(`非 JSON 响应 (${res.status})${hint}: ${text.slice(0, 120)}`);
    }
  }

  async getCsrf() {
    if (this.csrf) return this.csrf;
    const res = await this.raw("/settings/account", {
      extraHeaders: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
      },
    });
    const html = await res.text();
    const patterns = [
      /\\"token\\":\\"([a-f0-9]{20,})\\"/,
      /"token":"([a-f0-9]{20,})"/,
      /token\\?"\s*:\s*"([a-f0-9]{20,})"/,
      /token[^a-zA-Z0-9]{1,6}([a-f0-9]{32})/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        this.csrf = m[1];
        return this.csrf;
      }
    }
    throw new Error("拿不到 CSRF token（Cookie 可能失效）");
  }

  async postForm(path, form) {
    const token = await this.getCsrf();
    const body = new URLSearchParams({ lang: "zh", ...form }).toString();
    const res = await this.raw(path, {
      method: "POST",
      body,
      extraHeaders: {
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": token,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: true, raw: text.slice(0, 300) };
    }
  }

  getUserInfo(uid) {
    return this.json(`/ajax/user/${uid}`, { full: 1 });
  }

  async getArtistWorks(artistId) {
    const prof = await this.json(`/ajax/user/${artistId}/profile/all`);
    if (!prof || prof.error) throw new Error("profile/all 返回错误");

    const ids = [];
    for (const key of ["illusts", "manga"]) {
      const d = prof.body?.[key];
      if (Array.isArray(d)) {
        for (const x of d) {
          const v = typeof x === "object" && x ? x.id ?? x.illustId : x;
          if (v != null && /^\d+$/.test(String(v))) ids.push(String(v));
        }
      } else if (d && typeof d === "object") {
        for (const k of Object.keys(d)) if (/^\d+$/.test(k)) ids.push(k);
      }
    }
    const uniq = [...new Set(ids)]
      .map(Number)
      .sort((a, b) => b - a)
      .slice(0, 30);
    if (!uniq.length) return [];

    const detail = await this.json(`/ajax/user/${artistId}/profile/illusts`, {
      "ids[]": uniq.map(String),
      work_category: "illustManga",
      is_first_page: 0,
    });
    if (!detail || detail.error) throw new Error("profile/illusts 返回错误");

    const works = detail.body?.works || {};
    return Object.entries(works).map(([id, info]) => ({
      id,
      title: info?.title || "",
      createDate: info?.createDate || "",
    }));
  }

  postComment(illustId, text) {
    return this.postForm("/rpc/post_comment.php", {
      illust_id: String(illustId),
      author_user_id: String(this.userId),
      type: "comment",
      comment: text,
    });
  }
}
