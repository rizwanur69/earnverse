import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import { pool, initDb, withTx } from "./db.js";
import { validateTelegramInitData } from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

await initDb();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const botToken = process.env.BOT_TOKEN;
const miniAppUrl = process.env.MINI_APP_URL;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function setting(key, fallback = "") {
  const r = await pool.query("SELECT value FROM settings WHERE key=$1", [key]);
  return r.rows[0]?.value ?? fallback;
}

async function getUserFromReq(req, res) {
  try {
    const tgUser = validateTelegramInitData(req.headers["x-telegram-init-data"], botToken);
    const r = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [tgUser.id]);
    if (!r.rows[0]) {
      const created = await pool.query(
        `INSERT INTO users(telegram_id,username,first_name,last_name,photo_url)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [tgUser.id, tgUser.username || null, tgUser.first_name || "", tgUser.last_name || null, tgUser.photo_url || null]
      );
      return created.rows[0];
    }
    return r.rows[0];
  } catch (e) {
    res.status(401).json({ error: e.message || "Unauthorized" });
    return null;
  }
}

async function awardPoints(client, telegramId, amount, kind, referenceId, note) {
  if (!(amount > 0)) throw new Error("Invalid reward");
  const u = await client.query(
    "UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2 RETURNING points",
    [amount, telegramId]
  );
  if (!u.rows[0]) throw new Error("User not found");
  await client.query(
    `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
     VALUES($1,$2,$3,$4,$5)`,
    [telegramId, kind, amount, referenceId || null, note || null]
  );
  return Number(u.rows[0].points);
}

async function awardReferralCommission(client, telegramId, earnedAmount, sourceRef) {
  const percent = num(await setting("referral_percent", "10"), 10);
  if (!(percent > 0)) return;
  const u = await client.query(
    "SELECT referred_by FROM users WHERE telegram_id=$1",
    [telegramId]
  );
  const parent = u.rows[0]?.referred_by;
  if (!parent) return;
  const commission = earnedAmount * percent / 100;
  if (!(commission > 0)) return;
  const result = await client.query(
    `UPDATE users
     SET points=points+$1, referral_earnings=referral_earnings+$1, updated_at=NOW()
     WHERE telegram_id=$2 RETURNING points`,
    [commission, parent]
  );
  if (result.rows[0]) {
    await client.query(
      `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
       VALUES($1,'referral_commission',$2,$3,$4)`,
      [parent, commission, sourceRef || null, `Commission ${percent}%`]
    );
  }
}

app.get("/config", (_, res) => res.json({ botUsername: process.env.BOT_USERNAME || "" }));

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/api/bootstrap", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;

  const [tasks, recent, checkins, referrals, withdrawals] = await Promise.all([
    pool.query(
      `SELECT t.id,t.title,t.description,t.reward,t.type,t.url,t.daily,t.active,
       CASE WHEN EXISTS(
         SELECT 1 FROM task_claims c
         WHERE c.task_id=t.id AND c.telegram_id=$1
         AND c.claim_key=CASE WHEN t.daily THEN TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') ELSE 'once' END
       ) THEN true ELSE false END AS claimed
       FROM tasks t WHERE t.active=true ORDER BY t.id DESC`,
      [user.telegram_id]
    ),
    pool.query(
      `SELECT kind,amount,note,created_at FROM ledger
       WHERE telegram_id=$1 ORDER BY id DESC LIMIT 15`,
      [user.telegram_id]
    ),
    pool.query(
      `SELECT checkin_date,streak,reward FROM checkins
       WHERE telegram_id=$1 ORDER BY checkin_date DESC LIMIT 14`,
      [user.telegram_id]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count,
       COALESCE((SELECT SUM(amount) FROM ledger WHERE telegram_id=$1 AND kind='referral_commission'),0) AS earnings
       FROM users WHERE referred_by=$1`,
      [user.telegram_id]
    ),
    pool.query(
      `SELECT id,points,usdt,wallet,network,status,created_at
       FROM withdrawals WHERE telegram_id=$1 ORDER BY id DESC LIMIT 10`,
      [user.telegram_id]
    )
  ]);

  const settings = {
    coinName: await setting("coin_name", "MYCOIN"),
    pointsPerUsdt: num(await setting("points_per_usdt", "10000"), 10000),
    referralPercent: num(await setting("referral_percent", "2"), 2),
    checkinReward: num(await setting("checkin_reward", "100"), 100),
    minWithdrawUsdt: num(await setting("min_withdraw_usdt", "1"), 1),
    withdrawNetwork: await setting("withdraw_network", "TRC20"),
    adsEnabled: process.env.ADS_ENABLED === "true"
  };

  res.json({
    user: {
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      photoUrl: user.photo_url,
      points: Number(user.points),
      usdtBalance: Number(user.usdt_balance),
      referralEarnings: Number(user.referral_earnings)
    },
    settings,
    tasks: tasks.rows.map(x => ({ ...x, reward: Number(x.reward), id: Number(x.id), claimed: x.claimed })),
    ledger: recent.rows,
    checkins: checkins.rows,
    referrals: { count: referrals.rows[0].count, earnings: Number(referrals.rows[0].earnings) },
    withdrawals: withdrawals.rows.map(x => ({ ...x, points: Number(x.points), usdt: Number(x.usdt), id: Number(x.id) }))
  });
});

app.post("/api/start", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;

  const ref = String(req.body?.ref || "").trim();

  if (!ref || ref === String(user.telegram_id) || user.referred_by) {
    return res.json({ ok: true });
  }

  const referrer = await pool.query(
    "SELECT telegram_id FROM users WHERE telegram_id=$1",
    [ref]
  );

  if (!referrer.rows[0]) {
    return res.json({ ok: true });
  }

  try {
    await withTx(async client => {
      // Connect this new user to the referrer.
      const linked = await client.query(
        `UPDATE users
         SET referred_by=$1, updated_at=NOW()
         WHERE telegram_id=$2 AND referred_by IS NULL
         RETURNING telegram_id`,
        [Number(ref), user.telegram_id]
      );

      // Only give the 200 EV signup bonus if the referral
      // was actually linked for the first time.
      if (!linked.rows[0]) return;

      const referralBonus = 200;

      await awardPoints(
        client,
        Number(ref),
        referralBonus,
        "referral_bonus",
        String(user.telegram_id),
        "Referral signup bonus"
      );
    });

    res.json({ ok: true, referralBonus: 200 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/checkin", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  try {
    const result = await withTx(async client => {
      const reward = num(await setting("checkin_reward", "100"), 100);
      const today = new Date().toISOString().slice(0, 10);
      const prev = await client.query(
        `SELECT streak,checkin_date FROM checkins
         WHERE telegram_id=$1 ORDER BY checkin_date DESC LIMIT 1`,
        [user.telegram_id]
      );
      const prevDate = prev.rows[0]?.checkin_date?.toISOString?.().slice(0,10) || null;
      let streak = 1;
      if (prevDate) {
        const d1 = new Date(prevDate);
        const d2 = new Date(today);
        const diff = Math.round((d2 - d1) / 86400000);
        if (diff === 1) streak = Number(prev.rows[0].streak) + 1;
        else if (diff === 0) throw new Error("Already checked in today");
      }
      await client.query(
        "INSERT INTO checkins(telegram_id,checkin_date,reward,streak) VALUES($1,$2,$3,$4)",
        [user.telegram_id, today, reward, streak]
      );
      const points = await awardPoints(client, user.telegram_id, reward, "daily_checkin", today, `Day ${streak}`);
      await awardReferralCommission(client, user.telegram_id, reward, `checkin:${today}`);
      return { points, reward, streak };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/tasks/:id/claim", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid task" });

  try {
    const result = await withTx(async client => {
      const t = await client.query("SELECT * FROM tasks WHERE id=$1 AND active=true", [id]);
      if (!t.rows[0]) throw new Error("Task not available");
      const task = t.rows[0];

      // Manual tasks are intentionally admin-controlled. A browser click is NOT proof
      // of an external action. For production, set task.type to a provider-verified task.
      if (task.type === "manual") throw new Error("This task requires verified completion");

      const claimKey = task.daily ? new Date().toISOString().slice(0,10) : "once";
      const ins = await client.query(
        `INSERT INTO task_claims(task_id,telegram_id,claim_key,reward)
         VALUES($1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, user.telegram_id, claimKey, task.reward]
      );
      if (!ins.rows[0]) throw new Error("Already claimed");
      const points = await awardPoints(client, user.telegram_id, Number(task.reward), "task", String(id), task.title);
      await awardReferralCommission(client, user.telegram_id, Number(task.reward), `task:${id}`);
      return { points, reward: Number(task.reward) };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/exchange", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  const points = num(req.body?.points, 0);
  const rate = num(await setting("points_per_usdt", "10000"), 10000);
  if (!(points > 0) || !(rate > 0)) return res.status(400).json({ error: "Invalid amount" });

  try {
    const result = await withTx(async client => {
      const usdt = points / rate;
      const r = await client.query(
        `UPDATE users SET points=points-$1,usdt_balance=usdt_balance+$2,updated_at=NOW()
         WHERE telegram_id=$3 AND points >= $1 RETURNING points,usdt_balance`,
        [points, usdt, user.telegram_id]
      );
      if (!r.rows[0]) throw new Error("Insufficient points");
      const ref = crypto.randomUUID();
      await client.query(
        `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
         VALUES($1,'exchange',-$2,$3,$4)`,
        [user.telegram_id, points, ref, `${points} points -> ${usdt} USDT`]
      );
      await client.query(
        `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
         VALUES($1,'usdt_credit',$2,$3,$4)`,
        [user.telegram_id, usdt, ref, `Converted from ${points} points`]
      );
      return { points: Number(r.rows[0].points), usdt, usdtBalance: Number(r.rows[0].usdt_balance) };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/withdraw", async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  const usdt = num(req.body?.usdt, 0);
  const wallet = String(req.body?.wallet || "").trim();
  const network = String(req.body?.network || "TRC20").trim();
  const rate = num(await setting("points_per_usdt", "10000"), 10000);
  const min = num(await setting("min_withdraw_usdt", "1"), 1);
  if (!(usdt >= min)) return res.status(400).json({ error: `Minimum withdrawal is ${min} USDT` });
  if (!wallet || wallet.length < 10 || wallet.length > 120) return res.status(400).json({ error: "Invalid wallet" });

  try {
    const result = await withTx(async client => {
      const points = usdt * rate;
      const r = await client.query(
        `UPDATE users SET usdt_balance=usdt_balance-$1,updated_at=NOW()
         WHERE telegram_id=$2 AND usdt_balance >= $1 RETURNING points,usdt_balance`,
        [points, user.telegram_id]
      );
      if (!r.rows[0]) throw new Error("Insufficient points");
      const w = await client.query(
        `INSERT INTO withdrawals(telegram_id,points,usdt,wallet,network)
         VALUES($1,$2,$3,$4,$5) RETURNING id,status`,
        [user.telegram_id, points, usdt, wallet, network]
      );
      await client.query(
        `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
         VALUES($1,'withdraw_hold_usdt',-$2,$3,$4)`,
        [user.telegram_id, usdt, String(w.rows[0].id), `${usdt} USDT ${network}`]
      );
      return { withdrawalId: Number(w.rows[0].id), status: w.rows[0].status, points: Number(r.rows[0].points), usdtBalance: Number(r.rows[0].usdt_balance) };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rewarded-ad server callback. The exact payload/signature format must be mapped
// to your chosen ad provider's official server-to-server callback documentation.
app.post("/api/ads/reward-callback", async (req, res) => {
  if (process.env.ADS_ENABLED !== "true") return res.status(403).json({ error: "Ads disabled" });
  const secret = process.env.AD_CALLBACK_SECRET || "";
  const signature = String(req.headers["x-ad-signature"] || "");
  const raw = JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  if (!secret || signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: "Invalid ad signature" });
  }

  const eventId = String(req.body?.event_id || "");
  const telegramId = Number(req.body?.telegram_id);
  const reward = num(req.body?.reward, 0);
  if (!eventId || !Number.isSafeInteger(telegramId) || !(reward > 0) || reward > 1000000) {
    return res.status(400).json({ error: "Invalid callback" });
  }

  try {
    const result = await withTx(async client => {
      const exists = await client.query(
        "SELECT 1 FROM ledger WHERE kind='ad_reward' AND reference_id=$1 LIMIT 1",
        [eventId]
      );
      if (exists.rows[0]) return { duplicate: true };
      const points = await awardPoints(client, telegramId, reward, "ad_reward", eventId, "Verified rewarded ad");
      await awardReferralCommission(client, telegramId, reward, `ad:${eventId}`);
      return { duplicate: false, points };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MYCOIN Admin"');
    return res.status(401).send("Authentication required");
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  if (user !== process.env.ADMIN_USER || pass !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }
  next();
}

app.get("/admin", adminAuth, (_, res) => res.sendFile(path.join(__dirname, "../web/admin.html")));

app.get("/api/admin/summary", adminAuth, async (_, res) => {
  const [u,t,w,p] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM users"),
    pool.query("SELECT COUNT(*)::int AS n FROM tasks WHERE active=true"),
    pool.query("SELECT COUNT(*)::int AS n FROM withdrawals WHERE status='pending'"),
    pool.query("SELECT COALESCE(SUM(points),0) AS n FROM users")
  ]);
  res.json({ users:u.rows[0].n, tasks:t.rows[0].n, pendingWithdrawals:w.rows[0].n, totalPoints:Number(p.rows[0].n) });
});

app.get("/api/admin/tasks", adminAuth, async (_, res) => {
  const r = await pool.query("SELECT * FROM tasks ORDER BY id DESC");
  res.json(r.rows.map(x => ({...x,id:Number(x.id),reward:Number(x.reward)})));
});

app.post("/api/admin/tasks", adminAuth, async (req,res) => {
  const {title,description="",reward=0,type="manual",url="",daily=false,active=true} = req.body || {};
  if (!String(title||"").trim() || !(Number(reward)>0)) return res.status(400).json({error:"Title and positive reward required"});
  const r = await pool.query(
    `INSERT INTO tasks(title,description,reward,type,url,daily,active)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [String(title).trim(),String(description),Number(reward),String(type),String(url||""),!!daily,!!active]
  );
  res.json({...r.rows[0],id:Number(r.rows[0].id),reward:Number(r.rows[0].reward)});
});

app.delete("/api/admin/tasks/:id", adminAuth, async(req,res)=>{
  await pool.query("DELETE FROM tasks WHERE id=$1",[Number(req.params.id)]);
  res.json({ok:true});
});

app.get("/api/admin/withdrawals", adminAuth, async (_,res)=>{
  const r=await pool.query(
    `SELECT w.*,u.username,u.first_name
     FROM withdrawals w JOIN users u ON u.telegram_id=w.telegram_id
     ORDER BY w.id DESC LIMIT 100`
  );
  res.json(r.rows.map(x=>({...x,id:Number(x.id),telegram_id:Number(x.telegram_id),points:Number(x.points),usdt:Number(x.usdt)})));
});

app.post("/api/admin/withdrawals/:id", adminAuth, async(req,res)=>{
  const id=Number(req.params.id);
  const status=String(req.body?.status||"");
  if(!["approved","rejected"].includes(status)) return res.status(400).json({error:"Invalid status"});
  try {
    const result=await withTx(async client=>{
      const w=await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",[id]);
      if(!w.rows[0]) throw new Error("Withdrawal not found");
      if(w.rows[0].status!=="pending") throw new Error("Already processed");
      if(status==="rejected"){
        await client.query("UPDATE users SET usdt_balance=usdt_balance+$1 WHERE telegram_id=$2",[w.rows[0].points,w.rows[0].telegram_id]);
        await client.query(
          `INSERT INTO ledger(telegram_id,kind,amount,reference_id,note)
           VALUES($1,'withdraw_refund_usdt',$2,$3,'Rejected withdrawal refund')`,
          [w.rows[0].telegram_id,w.rows[0].usdt,String(id)]
        );
      }
      const u=await client.query(
        `UPDATE withdrawals SET status=$1,admin_note=$2,processed_at=NOW()
         WHERE id=$3 RETURNING status`,
        [status,String(req.body?.note||""),id]
      );
      return u.rows[0];
    });
    res.json({ok:true,...result});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/admin/settings", adminAuth, async(req,res)=>{
  const allowed=["coin_name","points_per_usdt","referral_percent","checkin_reward","min_withdraw_usdt","withdraw_network"];
  for(const key of allowed){
    if(req.body?.[key]!==undefined){
      await pool.query(
        `INSERT INTO settings(key,value) VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        [key,String(req.body[key])]
      );
    }
  }
  res.json({ok:true});
});

app.use(express.static(path.join(__dirname, "../web")));

if (botToken && miniAppUrl) {
  const bot = new TelegramBot(botToken, { polling: false });

  const webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET || "earnverse-webhook-secret";

  app.post("/telegram/webhook", (req, res) => {
    const receivedSecret =
      req.headers["x-telegram-bot-api-secret-token"];

    if (receivedSecret !== webhookSecret) {
      return res.status(401).send("Unauthorized");
    }

    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot.setMyCommands([
    { command: "start", description: "Open EarnVerse" },
    { command: "help", description: "Help" }
  ]).catch(() => {});

  bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
    const ref = match?.[1] ? encodeURIComponent(match[1]) : "";
    const url = ref
      ? `${miniAppUrl}?startapp=${ref}`
      : miniAppUrl;

    await bot.sendMessage(msg.chat.id, "Welcome to EarnVerse.", {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🚀 Open EarnVerse",
            web_app: { url }
          }
        ]]
      }
    });
  });

  bot.onText(/^\/help/, async msg => {
    await bot.sendMessage(
      msg.chat.id,
      "Open EarnVerse from the button."
    );
  });

  bot
    .setWebHook(`${miniAppUrl}/telegram/webhook`, {
      secret_token: webhookSecret
    })
    .then(() => console.log("Telegram webhook enabled"))
    .catch(err => console.error("Webhook setup failed:", err.message));
}

app.listen(PORT, () => console.log(`MYCOIN server running on ${PORT}`));
