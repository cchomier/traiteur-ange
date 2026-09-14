// api/reprise.js — Fonction serverless Vercel
// Renvoie le PANIER structure d'un devis a partir de son jeton de reprise (uuid opaque).
// Sert a rouvrir un devis dans le formulaire pour en renvoyer une v2.
// Ne renvoie QUE ref + panier : jamais toute la ligne. Acces par jeton non devinable.
//
// Variables d'environnement Vercel (deja en place, memes que send-order) :
//   SUPABASE_URL               https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  cle service_role (SERVEUR UNIQUEMENT, jamais cote client)
const SB_TABLE = "commandes_traiteur";

// uuid : 8-4-4-4-12 hexa. On refuse tout ce qui n'a pas cette forme AVANT d'interroger
// la base : un parametre libre n'atteint jamais PostgREST.
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Methode non autorisee" });

  const token = String((req.query && req.query.token) || "").trim();
  if (!RE_UUID.test(token)) return res.status(400).json({ error: "Jeton invalide" });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase non configure" });

  try {
    // select limite a ref+panier : la route ne fuit jamais le reste de la ligne.
    const q = `${url}/rest/v1/${SB_TABLE}?reprise_token=eq.${encodeURIComponent(token)}&select=ref,panier&limit=1`;
    const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return res.status(502).json({ error: "Lecture Supabase refusee", detail: await r.text() });
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: "Devis introuvable" });
    // Un devis emis AVANT la bascule n'a pas de panier structure : rien a rouvrir.
    if (!row.panier) return res.status(409).json({ error: "Devis sans panier reutilisable (emis avant la bascule)" });
    return res.status(200).json({ ref: row.ref, panier: row.panier });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", detail: String(err) });
  }
}
