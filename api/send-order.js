// api/send-order.js — Fonction serverless Vercel (envoi email + PDF via Resend)
// Variable d'environnement requise sur Vercel : RESEND_API_KEY

// Destinataire : l'adresse du COMPTE Resend (mode test = envoi possible uniquement vers elle).
// Ici cchomier ; une redirection Gmail cchomier -> commandes.ange74 alimente la boîte boulangerie.
const RECIPIENT = "cchomier@gmail.com";

const FROM = "Traiteur Ange <onboarding@resend.dev>";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY manquante sur Vercel" });

  try {
    const { ref, clientName, bakeryName, bakeryEmail, replyTo, text, html, pdfBase64, filename } = req.body || {};

    // Multi-boulangeries : quand tu auras vérifié un domaine dans Resend, tu pourras router
    // vers la boîte de chaque boulangerie -> remplace RECIPIENT par (bakeryEmail || RECIPIENT).
    const to = [RECIPIENT];

    const payload = {
      from: FROM,
      to,
      subject: `Commande traiteur${bakeryName ? " [" + bakeryName + "]" : ""} ${ref || ""} — ${clientName || "client"}`,
      text: text || "Nouvelle commande traiteur.",
    };
    if (html) payload.html = html;
    if (replyTo) payload.reply_to = replyTo;
    if (pdfBase64) payload.attachments = [{ filename: filename || "commande.pdf", content: pdfBase64 }];

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return res.status(502).json({ error: "Échec envoi Resend", detail: await r.text() });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", detail: String(err) });
  }
}
