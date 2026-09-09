// api/catalogue.js — Fonction serverless Vercel
// Renvoie le catalogue traiteur depuis Supabase (table `produits_traiteur`).
//
// Pourquoi une route serveur plutot qu'un appel direct depuis le navigateur :
//   1) la cle Supabase ne descend jamais chez le client ;
//   2) la reponse est mise en cache par Vercel, donc la base n'est pas
//      interrogee a chaque visite ;
//   3) la forme des donnees est traduite ici, une seule fois, vers ce
//      qu'attend index.html — la page n'a pas a connaitre le schema SQL.
//
// Variables d'environnement Vercel (les memes que send-order.js, rien a ajouter) :
//   SUPABASE_URL               — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  — cle service_role (SERVEUR UNIQUEMENT)
//
// Si la route echoue, index.html garde son catalogue de repli fige : une page
// vide serait un client perdu, une page un peu ancienne ne l'est pas.
const SB_TABLE = "produits_traiteur";

// Colonnes demandees explicitement : la cle service_role ignore la RLS, donc
// c'est cette liste — et le filtre actif=true — qui garantissent qu'on
// n'expose que le catalogue public, rien d'autre.
const COLONNES = "ordre,gamme,nom,unite,bouchees,minimum,tarif_ttc,tva,type,photo";

/** La base stocke les unites sans accent ; l'application, elle, compare a "pièce". */
function uniteApp(u) {
  return u === "piece" ? "pièce" : u;
}

/** Ligne SQL -> objet attendu par le bloc PRODUITS d'index.html. */
function versProduit(r) {
  return {
    gamme: r.gamme,
    nom: r.nom,
    unite: uniteApp(r.unite),
    bouchees: Number(r.bouchees) || 0,
    minimum: Number(r.minimum) || 1,
    // PostgREST renvoie les numeric en chaine : sans Number(), tous les calculs
    // de prix de la page passeraient en concatenation de texte.
    tarifTTC: Number(r.tarif_ttc),
    tva: Number(r.tva),
    type: r.type || null,
    photo: r.photo || null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).json({ error: "Supabase non configuré" });

  try {
    const q =
      `${url}/rest/v1/${SB_TABLE}` +
      `?select=${encodeURIComponent(COLONNES)}` +
      `&actif=eq.true` +
      `&order=ordre.asc`;

    const r = await fetch(q, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return res.status(502).json({ error: "Lecture Supabase refusée", detail: await r.text() });

    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) {
      // Mieux vaut dire "rien" que renvoyer un catalogue vide qui remplacerait
      // le repli de la page par du vide.
      return res.status(503).json({ error: "Catalogue vide" });
    }

    const produits = rows.map(versProduit);

    // 60 s de cache CDN, puis service de la version perimee pendant que Vercel
    // rafraichit en arriere-plan : une correction de prix est visible en une
    // minute, et la base n'est jamais martelee.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ produits, total: produits.length });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", detail: String(err) });
  }
}
