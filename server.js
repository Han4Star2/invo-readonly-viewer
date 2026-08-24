import express from "express";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API = "https://api.invoapp.com";

let accessToken = process.env.INVO_ACCESS_TOKEN || "";
let refreshToken = process.env.INVO_REFRESH_TOKEN || "";

const commonHeaders = {
  "Content-Type": "application/json",
  "x-app-version": "0.0.75",
  "x-platform": "web"
};

async function invo(path, {method="POST", body=null, auth=true}={}) {
  const headers = {...commonHeaders};
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const r = await fetch(API + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }

  if (!r.ok) {
    const err = new Error(`Invo API HTTP ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function refresh() {
  if (!refreshToken) return false;
  try {
    const r = await fetch(API + "/v1_0/auth/refresh_token", {
      method: "GET",
      headers: {...commonHeaders, Authorization: `Bearer ${refreshToken}`}
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!r.ok) return false;

    accessToken =
      data.accessToken ||
      data.access_token ||
      data.token ||
      data.jwt ||
      data?.data?.accessToken ||
      data?.data?.access_token ||
      accessToken;

    return !!accessToken;
  } catch {
    return false;
  }
}

async function withRefresh(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 401 && await refresh()) return await fn();
    throw e;
  }
}

app.get("/api/health", (req,res) => {
  res.json({
    ok:true,
    configured:!!(accessToken || refreshToken),
    mode:"read-only"
  });
});

app.post("/api/portfolios", async (req,res) => {
  const {tag} = req.body || {};
  if (!tag) return res.status(400).json({error:"Missing tag"});

  try {
    const raw = String(tag).trim().replace(/^@/,"").toLowerCase();

    const data = await withRefresh(() => invo("/v1_0/trending/get_portfolios_pl", {
      body: {
        filter:"all",
        params:{page:1,size:100}
      }
    }));

    const items = Array.isArray(data?.items) ? data.items : [];

    const matches = items.filter(p => {
      const vals = [
        p.username, p.ownerUsername, p.owner?.username,
        p.tag, p.accountTag, p.handle
      ].filter(Boolean).map(String).map(x=>x.toLowerCase());
      return vals.some(x => x === raw || x === "@"+raw);
    });

    res.json({
      ok:true,
      tag,
      count:matches.length,
      portfolios:matches
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error:e.message,
      detail:e.data || null,
      hint:"The Invo API is reverse-engineered and may require a current authenticated token."
    });
  }
});

app.post("/api/trades", async (req,res) => {
  const {portfolioId} = req.body || {};
  if (!portfolioId) return res.status(400).json({error:"Missing portfolioId"});

  try {
    let posts=[];
    let lastPostId=null;

    for (let page=0; page<5; page++) {
      const data = await withRefresh(() => invo("/v1_0/posts/get_feed", {
        body: {
          filter:{filter:"all",assetTypes:[]},
          params:{lastPostId,itemLimit:50}
        }
      }));

      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) break;
      posts.push(...items);
      lastPostId = items[items.length-1]?.id;
      if (items.length < 50) break;
    }

    const trades = posts.map(post => {
      const u=post?.update;
      if (!u?.ticker || u?.verifiedTrade !== true) return null;
      if (String(u?.portfolio?.id) !== String(portfolioId)) return null;

      return {
        postId:post.id,
        timestamp:post.createdAt || u.createdAt || null,
        coin:u.ticker,
        side:u.directionLong ? "long" : "short",
        leverage:u.leverage ?? null,
        entryPrice:u.entryPrice ?? null,
        closingPrice:u.closingPrice ?? null,
        isOpen:u.isOpen === true,
        action:(u.isOpen === false && u.closingPrice != null) ? "close" : "open",
        baseId:u.baseId ?? null,
        baseShortId:u.baseShortId ?? null
      };
    }).filter(Boolean);

    trades.sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0));

    res.json({ok:true,portfolioId,trades});
  } catch (e) {
    res.status(e.status || 500).json({
      error:e.message,
      detail:e.data || null
    });
  }
});

app.get("/api/public-profile", async (req, res) => {
  const tag = String(req.query.tag || "")
    .trim()
    .replace(/^@/, "");

  if (!tag) {
    return res.status(400).json({
      error: "Missing tag"
    });
  }

  const url = `https://app.invoapp.com/${encodeURIComponent(tag)}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const text = await response.text();

    res.json({
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type"),
      length: text.length,
      preview: text.slice(0, 2000)
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Invo read-only viewer: http://localhost:${PORT}`);
});
