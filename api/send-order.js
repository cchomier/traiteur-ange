// api/send-order.js — Fonction serverless Vercel
// 1) Journalise la demande dans Airtable (filet de sécurité)  2) Journalise aussi dans
//    Supabase (double écriture, préparation Étape 2)  3) Envoie l'e-mail + PDF via Resend
//
// Variables d'environnement Vercel :
//   RESEND_API_KEY              (obligatoire) — envoi e-mail
//   AIRTABLE_TOKEN             (optionnel)   — jeton d'accès personnel Airtable (scopes data.records:write)
//   AIRTABLE_BASE_ID           (optionnel)   — identifiant de la base, commence par "app"
//   AIRTABLE_TABLE             (optionnel)   — nom de la table, défaut "Commandes"
//   SUPABASE_URL               (optionnel)   — https://<ref>.supabase.co (projet de l'app)
//   SUPABASE_SERVICE_ROLE_KEY  (optionnel)   — clé service_role (SERVEUR UNIQUEMENT, jamais côté client)
// Si les variables Airtable OU Supabase sont absentes, la journalisation correspondante est
// simplement ignorée : l'e-mail part normalement. Une panne d'un journal ne bloque JAMAIS la commande.
// Destinataire : boîte dédiée de la boulangerie. Domaine ange74.fr vérifié chez Resend
// (sending enabled, 10/08/2026) -> envoi direct, plus de redirection via cchomier.
const RECIPIENT = "commandes.ange74@gmail.com";
const FROM = "Devis Traiteur Ange <devis@ange74.fr>";
const AT_TABLE = process.env.AIRTABLE_TABLE || "Commandes";
const AT_PDF_FIELD = "Devis PDF";
const SB_TABLE = "commandes_traiteur";

/* ---------- Réponse au client en un clic (21/08/2026) ---------- */
// Pourquoi : jusqu'ici l'e-mail reçu par la boulangerie ne permettait pas de répondre
// au client sans le recopier depuis le PDF. Résultat : le client n'était pas prévenu
// que sa demande était arrivée, et rappelait. Ici, un bouton en tête d'e-mail ouvre
// la messagerie avec destinataire, objet ET message déjà écrits.
// Le texte est court exprès : il doit être relu et envoyé en dix secondes au comptoir.

/** "2026-09-12" -> "12/09/2026". Découpage plutôt que new Date() : pas de décalage de fuseau. */
function dateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** Échappe ce qui vient du formulaire client avant de l'insérer dans du HTML. */
function echapper(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Construit le bloc "Répondre au client" : version HTML et version texte brut.
 * Retourne des chaînes vides si le client n'a pas laissé d'e-mail.
 */
function blocReponseClient({ ref, order }) {
  const o = order || {};
  const email = String(o.email || "").trim();
  if (!email) return { html: "", texte: "" };

  const prenom = String(o.client || "").trim();
  const quand = dateFr(o.dateISO);
  const heure = String(o.heure || "").trim();
  const tel = String(o.tel || "").trim();

  const objet = `Votre demande traiteur${ref ? " " + ref : ""} — bien reçue`;

  // \r\n et non \n : Outlook et Mail iOS ignorent le simple saut de ligne dans un
  // mailto et collent tout le message sur une seule ligne.
  const corps = [
    `Bonjour${prenom ? " " + prenom : ""},`,
    "",
    `Nous avons bien reçu votre demande traiteur${quand ? " pour le " + quand : ""}${
      heure ? " à " + heure : ""
    }.`,
    "Elle est prise en compte, nous revenons vers vous très vite.",
    "",
    "Belle journée,",
    "Boulangerie Ange — Grand Epagny",
  ].join("\r\n");

  // L'adresse n'est PAS encodée : plusieurs messageries refusent un "@" transformé
  // en %40. Objet et corps le sont, eux, obligatoirement.
  const lienBrut = `mailto:${email}?subject=${encodeURIComponent(
    objet
  )}&body=${encodeURIComponent(corps)}`;

  // Dans du HTML, le "&" qui sépare subject et body doit être écrit "&amp;",
  // sinon certains clients coupent le lien juste avant le corps du message.
  const lienHtml = lienBrut.replace(/&/g, "&amp;");

  const police =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const html = `
<div style="margin:0 0 24px;padding:18px;border:1px solid #E9E4D6;border-radius:14px;background:#FDFBF5;font-family:${police}">
  <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#6E6A5E;letter-spacing:.02em;text-transform:uppercase">Client</p>
  <p style="margin:0 0 4px;font-size:16px;font-weight:800;color:#1A1A16">${echapper(
    prenom || "Client"
  )}</p>
  <p style="margin:0 0 16px;font-size:14px;color:#1A1A16">
    <a href="mailto:${echapper(email)}" style="color:#1A1A16">${echapper(email)}</a>${
    tel
      ? ` &nbsp;·&nbsp; <a href="tel:${echapper(
          tel.replace(/[^\d+]/g, "")
        )}" style="color:#1A1A16">${echapper(tel)}</a>`
      : ""
  }
  </p>
  <a href="${lienHtml}" style="display:inline-block;padding:13px 22px;border-radius:999px;background:#0B0B0A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:14px">Répondre : commande prise en compte</a>
  <p style="margin:12px 0 0;font-size:12px;color:#6E6A5E">Le message est déjà écrit, il reste à le relire et à l'envoyer.</p>
</div>`.trim();

  const texte = [
    "",
    "",
    "----------------------------------------",
    "RÉPONDRE AU CLIENT",
    `E-mail : ${email}${tel ? "   Téléphone : " + tel : ""}`,
    "Message de prise en compte prêt à envoyer :",
    lienBrut,
    "----------------------------------------",
  ].join("\n");

  return { html, texte };
}

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
/* ---------- Journalisation Supabase (double écriture, non bloquante) ---------- */
// Écrit la commande dans la table `commandes_traiteur` du projet Supabase de l'app,
// EN PLUS d'Airtable. Objectif : préparer la bascule (Étape 2) en gardant Airtable
// comme filet. Insertion via l'API REST PostgREST avec la clé service_role (qui ignore
// la RLS, côté serveur uniquement). Toute erreur est avalée : ni Airtable ni l'e-mail
// ne doivent en pâtir. Le PDF n'est pas repris ici (Airtable garde la pièce jointe).
async function logToSupabase({ ref, order }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { logged: false, reason: "Supabase non configuré" };
  const o = order || {};
  // Le CHECK de la colonne `mode` n'accepte que Retrait/Livraison : toute autre
  // valeur est neutralisée en null pour ne jamais faire échouer l'insertion.
  const mode = ["Retrait", "Livraison"].includes(o.mode) ? o.mode : null;
  const row = {
    ref: ref || o.ref || null,
    client: o.client || null,
    telephone: o.tel || null,
    email: o.email || null,
    date_souhaitee: o.dateISO || null, // "" -> null (une colonne date refuse la chaîne vide)
    heure: o.heure || null,
    mode,
    adresse: o.adresse || null,
    convives: typeof o.convives === "number" ? o.convives : null,
    total_ttc: typeof o.ttc === "number" ? o.ttc : null,
    a_encaisser: typeof o.encaisser === "number" ? o.encaisser : null,
    bouchees_par_pers: o.bouchees || null,
    detail_devis: o.detail || null,
    precisions_client: o.note || null,
    facturation: o.facturation || null,
    boulangerie: o.boulangerie || null,
    // statut ('À traiter') et org_id : laissés aux valeurs par défaut de la table.
  };
  const r = await fetch(`${url}/rest/v1/${SB_TABLE}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) return { logged: false, reason: await r.text() };
  return { logged: true };
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
    // 1 bis) Double écriture Supabase (préparation Étape 2), non bloquante.
    let journalSupabase = { logged: false, reason: "non tenté" };
    try {
      journalSupabase = await logToSupabase({ ref, order });
    } catch (e) {
      journalSupabase = { logged: false, reason: String(e) };
    }
    // 2) E-mail boulangerie
    // Domaine ange74.fr vérifié : envoi à la boîte dédiée. Multi-boulangeries : pour router
    // vers la boîte de chaque boulangerie -> remplace RECIPIENT par (bakeryEmail || RECIPIENT).
    const to = [RECIPIENT];

    // Bloc "Répondre au client" : construit ici, côté serveur, pour que le libellé du
    // message de prise en compte vive à UN seul endroit et non dans chaque gabarit.
    let bloc = { html: "", texte: "" };
    try {
      bloc = blocReponseClient({ ref, order });
    } catch (e) {
      // Un e-mail sans bouton reste un e-mail complet : on ne fait jamais échouer l'envoi
      // pour un élément de confort.
      bloc = { html: "", texte: "" };
    }

    const payload = {
      from: FROM,
      to,
      subject: `Devis traiteur${bakeryName ? " [" + bakeryName + "]" : ""} ${ref || ""} — ${clientName || "client"}`,
      text: (text || "Nouvelle commande traiteur.") + bloc.texte,
    };
    // Le bloc est placé EN TÊTE : sur téléphone, la boulangerie voit l'action avant
    // d'avoir à faire défiler tout le détail de la commande.
    if (html) payload.html = bloc.html + html;
    else if (bloc.html) payload.html = bloc.html;

    // Répondre directement depuis la messagerie doit atterrir chez le client. Si le
    // formulaire n'a pas transmis replyTo, on retombe sur l'e-mail saisi par le client.
    const repondreA = replyTo || String((order && order.email) || "").trim();
    if (repondreA) payload.reply_to = repondreA;

    if (pdfBase64) payload.attachments = [{ filename: filename || "commande.pdf", content: pdfBase64 }];
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      // L'e-mail a échoué mais la commande est peut-être déjà dans les journaux.
      return res.status(502).json({ error: "Échec envoi Resend", detail: await r.text(), journal, journalSupabase });
    }
    return res.status(200).json({ ok: true, journal, journalSupabase });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", detail: String(err) });
  }
}
