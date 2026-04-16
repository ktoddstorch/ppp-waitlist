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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
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
        dateStyle: "full",
        timeStyle: "short",
      });
      const typeLabel = user_type === "coach" ? "Coach" : "Player";
      await transporter.sendMail({
        from: `"P³ Waitlist" <${GMAIL_USER}>`,
        to: ALERT_EMAIL,
        subject: `🎯 New P³ Waitlist Signup — ${typeLabel}`,
        text: [
          `New waitlist signup!`,
          ``,
          `Name: ${name.trim()}`,
          `Email: ${email.trim()}`,
          `Phone: ${phone?.trim() || "Not provided"}`,
          `Type: ${typeLabel}`,
          `Signed up: ${timestamp}`,
        ].join("\n"),
        html: [
          `<h2 style="margin:0 0 16px;font-family:sans-serif;">🎯 New P³ Waitlist Signup</h2>`,
          `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">`,
          `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600;">Name</td><td style="padding:6px 0;">${name.trim()}</td></tr>`,
          `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600;">Email</td><td style="padding:6px 0;"><a href="mailto:${email.trim()}">${email.trim()}</a></td></tr>`,
          `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600;">Phone</td><td style="padding:6px 0;">${phone?.trim() || "—"}</td></tr>`,
          `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600;">Type</td><td style="padding:6px 0;"><strong style="color:#34d364;">${typeLabel}</strong></td></tr>`,
          `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-weight:600;">Signed up</td><td style="padding:6px 0;">${timestamp}</td></tr>`,
          `</table>`,
        ].join(""),
      });
    } catch (err) {
      console.error("[waitlist] Email alert failed:", err.message);
      // Don't fail the signup — email is best-effort
    }
  }

  // 3) Success
  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
