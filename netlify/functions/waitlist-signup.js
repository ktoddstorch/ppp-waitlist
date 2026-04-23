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
  const PERSONALOS_URL = process.env.PERSONALOS_SUPABASE_URL;
  const PERSONALOS_KEY = process.env.PERSONALOS_SUPABASE_SERVICE_ROLE_KEY;
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

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanPhone = phone?.trim() || null;
  const firstSpace = cleanName.indexOf(" ");
  const firstName = firstSpace === -1 ? cleanName : cleanName.slice(0, firstSpace);
  const lastName = firstSpace === -1 ? null : cleanName.slice(firstSpace + 1).trim() || null;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

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
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
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
      const safeName  = cleanName.replace(/[<>]/g, "");
      const safeEmail = cleanEmail.replace(/[<>]/g, "");
      const safePhone = (cleanPhone || "Not provided").replace(/[<>]/g, "");
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

  // 3) Send welcome email to the signup
  if (GMAIL_USER && GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      });

      const safeFirstName = (firstName || "there").replace(/[<>]/g, "");
      const fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      const bodyStyle = `font-family:${fontStack};font-size:15px;line-height:1.7;color:#1a1a2e;`;
      const pStyle = `margin:0 0 16px 0;${bodyStyle}`;
      const emphasisStyle = `margin:0 0 16px 0;font-family:${fontStack};font-size:16px;line-height:1.5;font-weight:500;color:#1a1a2e;`;
      const listStyle = `margin:0 0 16px 0;padding-left:20px;${bodyStyle}`;
      const liStyle = `margin-bottom:8px;`;
      const sigStyle = `border-top:0.5px solid #e0e0e0;padding-top:14px;margin-top:24px;font-family:${fontStack};font-size:13px;line-height:1.5;color:#666;`;
      const badgeStyle = `display:inline-block;background:#0a0f1e;color:#34d364;padding:6px 14px;border-radius:8px;font-weight:500;letter-spacing:1px;text-transform:uppercase;font-size:12px;font-family:${fontStack};`;
      const shareLinkStyle = `color:#1d9e75;font-weight:500;text-decoration:none;`;

      const subject = user_type === "coach"
        ? "Your Founding Coach spot is locked in 🎯"
        : "You're in — Your Performance Journey starts here 🎯";

      const playerHtml = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:40px;">
        <tr><td>
          <div style="margin-bottom:24px;"><span style="${badgeStyle}">P³</span></div>
          <p style="${pStyle}">Hey ${safeFirstName} —</p>
          <p style="${pStyle}">You just claimed a Founding Spot in P³ — Pickleball Performance Platform. Real note from me, not a robot.</p>
          <p style="${pStyle}">Quick story on why this exists. Many of you saw me tracking every shot on my Apple Watch and leaving myself voice recordings after <strong>every. single. game.</strong> What you didn't see was me logging every shot into a spreadsheet every night. That was the genesis of P³. I'm a competitive player who got obsessed with one question — <em>am I actually improving?</em> The patterns I couldn't see before became obvious once the data showed up.</p>
          <p style="${pStyle}">P³ is the coaching platform built to help every competitive player improve with proof. Every session. Every insight. Built on The 258™, our proprietary coaching framework.</p>
          <p style="${emphasisStyle}">Your Performance Journey starts here.</p>
          <p style="${pStyle}">The journey is the fun — the curiosity, the small wins, the coaching, the drills, the games. The proof is what's waiting on the other side.</p>
          <p style="${pStyle}"><strong>What happens next:</strong></p>
          <ul style="${listStyle}">
            <li style="${liStyle}">Your account will be free when beta opens</li>
            <li style="${liStyle}">As a Founding Member, you lock in special Founder's pricing on any paid tier — forever. You'll never pay full price.</li>
            <li style="${liStyle}">I'll share the full story behind the build over the next few weeks</li>
            <li style="${liStyle}">When beta opens, you're in first</li>
          </ul>
          <p style="${pStyle}">In the meantime — if you know another player who wants to improve their game, send them here: <a href="https://p3waitlist.netlify.app" style="${shareLinkStyle}">p3waitlist.netlify.app</a></p>
          <p style="${pStyle}">See you on court,<br>Todd</p>
          <div style="${sigStyle}">
            <div>Todd Storch</div>
            <div>Founder, P³</div>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const coachHtml = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:40px;">
        <tr><td>
          <div style="margin-bottom:24px;"><span style="${badgeStyle}">P³</span></div>
          <p style="${pStyle}">Hey ${safeFirstName} —</p>
          <p style="${pStyle}">You just claimed a Founding Coach spot in P³ — Pickleball Performance Platform. Real note from me, not a robot.</p>
          <p style="${pStyle}">Quick story on why this exists. Many of you saw me tracking every shot on my Apple Watch and leaving myself voice recordings after <strong>every. single. game.</strong> What you didn't see was me logging every shot into a spreadsheet every night. That was the genesis of P³. I'm a competitive player who got obsessed with one question — <em>am I actually improving?</em> The patterns I couldn't see before became obvious once the data showed up.</p>
          <p style="${pStyle}">P³ is the coaching platform built on The 258™, our proprietary coaching framework. It helps competitive players improve with proof, and gives coaches a way to see what their players are actually working on between sessions.</p>
          <p style="${emphasisStyle}">This is Your Performance Journey — yours and your players'.</p>
          <p style="${pStyle}"><strong>What Founding Coaches get:</strong></p>
          <ul style="${listStyle}">
            <li style="${liStyle}">A client dashboard to track the players you work with</li>
            <li style="${liStyle}">Founder's pricing on any paid tier, locked in forever</li>
            <li style="${liStyle}">Direct input on the coach-specific features as we build them</li>
            <li style="${liStyle}">Only 25 Founding Coach spots total — you're in</li>
          </ul>
          <p style="${pStyle}">I'll reach out personally in the next week to learn about your coaching practice and how P³ fits. If you have questions before then, reply to this email — goes straight to me.</p>
          <p style="${pStyle}">Know another coach or player who wants to improve their game? Send them here: <a href="https://p3waitlist.netlify.app" style="${shareLinkStyle}">p3waitlist.netlify.app</a></p>
          <p style="${pStyle}">Talk soon,<br>Todd</p>
          <div style="${sigStyle}">
            <div>Todd Storch</div>
            <div>Founder, P³</div>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const playerText = `Hey ${safeFirstName} —

You just claimed a Founding Spot in P³ — Pickleball Performance Platform. Real note from me, not a robot.

Quick story on why this exists. Many of you saw me tracking every shot on my Apple Watch and leaving myself voice recordings after every. single. game. What you didn't see was me logging every shot into a spreadsheet every night. That was the genesis of P³. I'm a competitive player who got obsessed with one question — am I actually improving? The patterns I couldn't see before became obvious once the data showed up.

P³ is the coaching platform built to help every competitive player improve with proof. Every session. Every insight. Built on The 258™, our proprietary coaching framework.

Your Performance Journey starts here.

The journey is the fun — the curiosity, the small wins, the coaching, the drills, the games. The proof is what's waiting on the other side.

What happens next:
- Your account will be free when beta opens
- As a Founding Member, you lock in special Founder's pricing on any paid tier — forever. You'll never pay full price.
- I'll share the full story behind the build over the next few weeks
- When beta opens, you're in first

In the meantime — if you know another player who wants to improve their game, send them here: p3waitlist.netlify.app

See you on court,
Todd

Todd Storch
Founder, P³`;

      const coachText = `Hey ${safeFirstName} —

You just claimed a Founding Coach spot in P³ — Pickleball Performance Platform. Real note from me, not a robot.

Quick story on why this exists. Many of you saw me tracking every shot on my Apple Watch and leaving myself voice recordings after every. single. game. What you didn't see was me logging every shot into a spreadsheet every night. That was the genesis of P³. I'm a competitive player who got obsessed with one question — am I actually improving? The patterns I couldn't see before became obvious once the data showed up.

P³ is the coaching platform built on The 258™, our proprietary coaching framework. It helps competitive players improve with proof, and gives coaches a way to see what their players are actually working on between sessions.

This is Your Performance Journey — yours and your players'.

What Founding Coaches get:
- A client dashboard to track the players you work with
- Founder's pricing on any paid tier, locked in forever
- Direct input on the coach-specific features as we build them
- Only 25 Founding Coach spots total — you're in

I'll reach out personally in the next week to learn about your coaching practice and how P³ fits. If you have questions before then, reply to this email — goes straight to me.

Know another coach or player who wants to improve their game? Send them here: p3waitlist.netlify.app

Talk soon,
Todd

Todd Storch
Founder, P³`;

      await transporter.sendMail({
        from: `"P³" <${GMAIL_USER}>`,
        to: cleanEmail,
        subject,
        text: user_type === "coach" ? coachText : playerText,
        html: user_type === "coach" ? coachHtml : playerHtml,
      });
    } catch (err) {
      console.error("[waitlist] Welcome email failed:", err.message);
      // Don't fail the signup — email is best-effort
    }
  }

  // 4) CRM sync to Personal OS Supabase
  if (PERSONALOS_URL && PERSONALOS_KEY) {
    try {
      const posHeaders = {
        apikey: PERSONALOS_KEY,
        Authorization: `Bearer ${PERSONALOS_KEY}`,
        "Content-Type": "application/json",
      };

      // B1 — Check if contact exists
      const lookupRes = await fetch(
        `${PERSONALOS_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(cleanEmail)}&select=id,notes,beta_status&limit=1`,
        { headers: posHeaders }
      );
      if (!lookupRes.ok) {
        throw new Error(`contacts lookup ${lookupRes.status}: ${await lookupRes.text()}`);
      }
      const lookupRows = await lookupRes.json();
      const existing = Array.isArray(lookupRows) && lookupRows.length ? lookupRows[0] : null;

      let contactId;

      if (!existing) {
        // B2a — Insert new contact
        const insertPayload = {
          first_name: firstName,
          last_name: lastName,
          email: cleanEmail,
          phone: cleanPhone,
          contact_type: user_type,
          beta_status: "waitlist_public",
          beta_wave: null,
          last_contact_date: today,
          next_action: "Invite to beta when Wave 3 opens",
          next_action_due: null,
          notes: "Self-signup via p3waitlist.netlify.app",
        };
        const insertContactRes = await fetch(`${PERSONALOS_URL}/rest/v1/contacts`, {
          method: "POST",
          headers: { ...posHeaders, Prefer: "return=representation" },
          body: JSON.stringify(insertPayload),
        });
        if (!insertContactRes.ok) {
          throw new Error(`contacts insert ${insertContactRes.status}: ${await insertContactRes.text()}`);
        }
        const inserted = await insertContactRes.json();
        contactId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
      } else {
        // B2b — Update existing contact safely
        contactId = existing.id;
        const appendedNote = `[${today}] Joined public waitlist as ${user_type}`;
        const newNotes = existing.notes ? `${existing.notes}\n${appendedNote}` : appendedNote;
        const updatePayload = {
          last_contact_date: today,
          notes: newNotes,
        };
        // Only set beta_status if currently null — never overwrite an existing value
        if (existing.beta_status === null || existing.beta_status === undefined) {
          updatePayload.beta_status = "waitlist_public";
        }
        const updateRes = await fetch(
          `${PERSONALOS_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(cleanEmail)}`,
          {
            method: "PATCH",
            headers: { ...posHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(updatePayload),
          }
        );
        if (!updateRes.ok) {
          throw new Error(`contacts update ${updateRes.status}: ${await updateRes.text()}`);
        }
      }

      // B3 — Log contact_interaction
      if (contactId) {
        const interactionPayload = {
          contact_id: contactId,
          interaction_type: "waitlist_signup",
          interaction_channel: "other",
          interaction_date: today,
          summary: `Signed up as ${user_type} via p3waitlist_landing. Phone: ${cleanPhone || "not provided"}`,
        };
        const interactionRes = await fetch(`${PERSONALOS_URL}/rest/v1/contact_interactions`, {
          method: "POST",
          headers: { ...posHeaders, Prefer: "return=minimal" },
          body: JSON.stringify(interactionPayload),
        });
        if (!interactionRes.ok) {
          throw new Error(`contact_interactions insert ${interactionRes.status}: ${await interactionRes.text()}`);
        }
      } else {
        console.error("[waitlist] CRM sync: no contact_id resolved, skipping interaction log");
      }
    } catch (err) {
      console.error("[waitlist] CRM sync failed:", err.message);
      // Don't fail the signup — CRM sync is best-effort
    }
  } else {
    console.error("[waitlist] CRM sync skipped: PERSONALOS env vars not set");
  }

  // 5) Success
  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
