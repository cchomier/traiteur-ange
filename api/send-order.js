// api/send-order.js — Fonction serverless Vercel
// 1) Journalise la demande dans Airtable (filet de sécurité)  2) Envoie l'e-mail + PDF via Resend
//
// Variables d'environnement Vercel :
//   RESEND_API_KEY     (obligatoire)  — envoi e-mail
//   AIRTABLE_TOKEN     (optionnel)    — jeton d'accès personnel Airtable (scopes data.records:write)
//   AIRTABLE_BASE_ID   (optionnel)    — identifiant de la base, commence par "app"
//   AIRTABLE_TABLE     (optionnel)    — nom de la table, défaut "Commandes"
// Si les variables Airtable sont absentes, la journalisation est simplement ignorée :
// l'e-mail part normalement. Une panne Airtable ne bloque JAMAIS la commande.

// Destinataire : boîte dédiée de la boulangerie. Domaine ange74.fr vérifié chez Resend
// (sending enabled, 10/08/2026) -> envoi direct, plus de redirection via cchomier.
const RECIPIENT = "commandes.ange74@gmail.com";

const FROM = "Devis Traiteur Ange <devis@ange74.fr>";

const AT_TABLE = process.env.AIRTABLE_TABLE || "Commandes";
const AT_PDF_FIELD = "Devis PDF";

/* ---------- Journalisation Airtable ---------- */
async function logToAirtable({ ref, order, pdfBase64, filename }) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) return { logged: false, reason: "Airtable non configuré" };

  const o = order || {};
  const fields = {
    "Réf": ref || o.ref || "",
    "Statut": "À traiter",
    "Client": o.client || "",
    "Téléphone": o.tel || "",
    "E-mail": o.email || "",
    "Date souhaitée": o.dateISO || null,
    "Heure": o.heure || "",
    "Mode": o.mode || "",
    "Adresse": o.adresse || "",
    "Convives": typeof o.convives === "number" ? o.convives : null,
    "Total TTC": typeof o.ttc === "number" ? o.ttc : null,
    "À encaisser": typeof o.encaisser === "number" ? o.encaisser : null,
    "Bouchées / pers.": o.bouchees || "",
    "Détail commande": o.detail || "",
    "Précisions client": o.note || "",
    "Facturation": o.facturation || "",
    "Boulangerie": o.boulangerie || "",
  };
  // Airtable refuse les champs à null sur certains types : on nettoie.
  Object.keys(fields).forEach((k) => {
    if (fields[k] === null || fields[k] === "") delete fields[k];
  });

  const createUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(AT_TABLE)}`;
  // Tolérance aux erreurs de saisie : si un champ n'existe pas dans Airtable (faute de frappe,
  // accent oublié) ou refuse la valeur, on le retire et on retente. Mieux vaut une ligne
  // incomplète qu'aucune ligne du tout.
  let payloadFields = { ...fields };
  let rec = null;
  let lastError = "";
  for (let i = 0; i < 8; i++) {
    const r = await fetch(createUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: payloadFields, typecast: true }),
    });
    if (r.ok) { rec = await r.json(); break; }
    lastError = await r.text();
    let msg = lastError;
    try { msg = JSON.parse(lastError)?.error?.message || lastError; } catch (e) {}
    const m = /Unknown field name:\s*"?([^"]+)"?/i.exec(msg) || /Field\s+"([^"]+)"/i.exec(msg);
    if (m && Object.prototype.hasOwnProperty.call(payloadFields, m[1])) {
      delete payloadFields[m[1]];
      continue;
    }
    break;
  }
  if (!rec) return { logged: false, reason: lastError || "création refusée" };

  const recordId = rec.id;

  // Pièce jointe PDF (limite Airtable : 5 Mo par fichier)
  if (recordId && pdfBase64) {
    try {
      const upUrl = `https://content.airtable.com/v0/${baseId}/${recordId}/${encodeURIComponent(AT_PDF_FIELD)}/uploadAttachment`;
      await fetch(upUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contentType: "application/pdf",
          filename: filename || "devis.pdf",
          file: pdfBase64,
        }),
      });
    } catch (e) {
      // PDF non attaché : la ligne existe quand même, c'est l'essentiel.
    }
  }
  return { logged: true, recordId };
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RESEND_API_KEY manquante sur Vercel" });

  try {
    const { ref, clientName, bakeryName, bakeryEmail, replyTo, text, html, pdfBase64, filename, order } =
      req.body || {};

    // 1) Journal Airtable AVANT l'e-mail : même si Resend tombe, la demande est tracée.
    let journal = { logged: false, reason: "non tenté" };
    try {
      journal = await logToAirtable({ ref, order, pdfBase64, filename });
    } catch (e) {
      journal = { logged: false, reason: String(e) };
    }

    // 2) E-mail boulangerie
    // Domaine ange74.fr vérifié : envoi à la boîte dédiée. Multi-boulangeries : pour router
    // vers la boîte de chaque boulangerie -> remplace RECIPIENT par (bakeryEmail || RECIPIENT).
    const to = [RECIPIENT];

    const payload = {
      from: FROM,
      to,
      subject: `Devis traiteur${bakeryName ? " [" + bakeryName + "]" : ""} ${ref || ""} — ${clientName || "client"}`,
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
    if (!r.ok) {
      // L'e-mail a échoué mais la commande est peut-être déjà dans le journal.
      return res.status(502).json({ error: "Échec envoi Resend", detail: await r.text(), journal });
    }
    return res.status(200).json({ ok: true, journal });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", detail: String(err) });
  }
}
