const nodemailer = require("nodemailer");

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const PPP_URL = process.env.PPP_SUPABASE_URL;
  const PPP_KEY = process.env.PPP_SUPABASE_SERVICE_ROLE_KEY;
  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_PASS;
  const ALERT_EMAIL = process.env.ALERT_EMAIL || "toddstorch@gmail.com";

  if (!PPP_URL || !PPP_KEY) {
    console.error("[waitlist] Missing Supabase env vars");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const pppHeaders = {
    apikey: PPP_KEY,
    Authorization: `Bearer ${PPP_KEY}`,
  };

  // ── GET /waitlist-signup — return player + coach counts ──
  if (event.httpMethod === "GET") {
    try {
      const countFor = async (type) => {
        const res = await fetch(
          `${PPP_URL}/rest/v1/waitlist?select=id&user_type=eq.${type}`,
          { headers: { ...pppHeaders, Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" } }
        );
        const cr = res.headers.get("content-range") || "";
        const total = cr.split("/")[1];
        return total && total !== "*" ? parseInt(total, 10) : 0;
      };
      const [player_count, coach_count] = await Promise.all([countFor("player"), countFor("coach")]);
      return { statusCode: 200, headers, body: JSON.stringify({ player_count, coach_count }) };
    } catch (err) {
      console.error("[waitlist] GET counts failed:", err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Count failed" }) };
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { name, email, phone, user_type } = body;
  if (!name || !email || !user_type) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "name, email, and user_type are required" }) };
  }
  if (!["player", "coach"].includes(user_type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "user_type must be player or coach" }) };
  }

  // 1) Insert into Supabase waitlist table
  const insertRes = await fetch(`${PPP_URL}/rest/v1/waitlist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: PPP_KEY,
      Authorization: `Bearer ${PPP_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone?.trim() || null,
      user_type,
      source: "organic",
    }),
  });

  if (!insertRes.ok) {
    const text = await insertRes.text();
    // Duplicate email = unique constraint violation
    if (text.includes("duplicate") || text.includes("unique")) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: "You're already on the list!" }) };
    }
    console.error("[waitlist] Supabase insert failed:", insertRes.status, text);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to save signup" }) };
  }

  // 2) Send email alert to Todd
  if (GMAIL_USER && GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      });
      const timestamp = new Date().toLocaleString("en-US", {
        timeZone: "America/Chicago",
        month: "long", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      }) + " CT";
      const typeLabel = user_type === "coach" ? "Coach" : "Player";
      const typePill = user_type === "coach"
        ? `<span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;font-family:Arial,sans-serif;background:#0a0f1e;color:#ffffff;">COACH</span>`
        : `<span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;font-family:Arial,sans-serif;background:#34d364;color:#0a0f1e;">PLAYER</span>`;
      const safeName  = name.trim().replace(/[<>]/g, "");
      const safeEmail = email.trim().replace(/[<>]/g, "");
      const safePhone = (phone?.trim() || "Not provided").replace(/[<>]/g, "");
      const rowStyle  = `style="padding:12px 0;border-bottom:1px solid #f0f0f0;"`;
      const labelStyle = `style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#999;font-family:Arial,sans-serif;width:120px;vertical-align:top;padding-right:16px;"`;
      const valStyle   = `style="font-size:15px;font-weight:600;color:#0a0f1e;font-family:Arial,sans-serif;"`;

      await transporter.sendMail({
        from: `"P³ Waitlist" <${GMAIL_USER}>`,
        to: ALERT_EMAIL,
        subject: `🎯 New P³ Waitlist Signup — ${typeLabel}`,
        text: `New waitlist signup!\n\nName: ${safeName}\nEmail: ${safeEmail}\nPhone: ${safePhone}\nType: ${typeLabel}\nSigned up: ${timestamp}`,
        html: `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0f1e;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f1e;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;border-radius:8px;overflow:hidden;">
        <!-- HEADER -->
        <tr><td style="background:#0a0f1e;padding:32px;text-align:center;">
          <div style="font-family:Georgia,serif;font-size:28px;color:#34d364;letter-spacing:4px;">P ³</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);letter-spacing:3px;text-transform:uppercase;margin-top:8px;font-family:Arial,sans-serif;">Pickleball Performance Platform</div>
        </td></tr>
        <!-- BODY -->
        <tr><td style="background:#ffffff;padding:40px;">
          <div style="font-size:24px;font-weight:700;color:#0a0f1e;margin-bottom:8px;font-family:Arial,sans-serif;">New Waitlist Signup</div>
          <div style="font-size:14px;color:#666;margin-bottom:32px;font-family:Arial,sans-serif;">Someone just claimed their spot on P³.</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr ${rowStyle}><td ${labelStyle}>NAME</td><td ${valStyle}>${safeName}</td></tr>
            <tr ${rowStyle}><td ${labelStyle}>EMAIL</td><td ${valStyle}><a href="mailto:${safeEmail}" style="color:#0a0f1e;text-decoration:none;">${safeEmail}</a></td></tr>
            <tr ${rowStyle}><td ${labelStyle}>PHONE</td><td ${valStyle}>${safePhone}</td></tr>
            <tr ${rowStyle}><td ${labelStyle}>TYPE</td><td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">${typePill}</td></tr>
            <tr style="padding:12px 0;"><td ${labelStyle}>SIGNED UP</td><td ${valStyle}>${timestamp}</td></tr>
          </table>
        </td></tr>
        <!-- FOOTER -->
        <tr><td style="background:#f9f9f9;padding:24px 40px;text-align:center;">
          <div style="font-size:12px;color:#999;font-family:Arial,sans-serif;">P³ Waitlist &middot; toddstorch@gmail.com</div>
          <div style="font-size:11px;color:#bbb;font-family:Arial,sans-serif;margin-top:6px;">You're receiving this because you're the P³ founder.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
      });
    } catch (err) {
      console.error("[waitlist] Email alert failed:", err.message);
      // Don't fail the signup — email is best-effort
    }
  }

  // 3) Success
  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
