// api/webhook-resend.js — Webhook Resend : filet de securite pour les devis traiteur.
// Recoit les evenements Resend, verifie leur signature, et t'alerte par mail quand
// un devis client n'est PAS arrive : email.failed (Resend n'a pas pu envoyer) ou
// email.bounced (rejet du destinataire : adresse invalide, boite pleine...).
//
// Variables d'environnement requises sur Vercel :
//   - RESEND_API_KEY        (deja presente) : pour envoyer le mail d'alerte
//   - RESEND_WEBHOOK_SECRET (a ajouter)     : le "signing secret" whsec_... fourni
//                                             par Resend a la creation du webhook

import crypto from 'crypto'

// On coupe le parseur de corps de Vercel : la verification de signature a besoin
// du corps BRUT, octet pour octet. Si Vercel transforme le JSON avant nous, la
// signature calculee ne correspond plus a celle de Resend. C'est LE piege du webhook.
export const config = { api: { bodyParser: false } }

// Destinataires de l'alerte : les 2 boites, pour etre sur d'etre prevenu.
const ALERTE_TO = ['cchomier@gmail.com', 'commandes.ange74@gmail.com']

// Expediteur de l'alerte : le domaine verifie (bonne delivrabilite).
const ALERTE_FROM = 'Alerte devis Ange <devis@ange74.fr>'

// Marqueur dans l'objet de l'alerte. Sert aussi de garde anti-boucle : si un mail
// d'alerte echouait a son tour, on ne renvoie pas une alerte sur l'alerte.
const ALERTE_MARQUEUR = '[ALERTE DEVIS]'

// Les evenements qui signifient "le devis n'est pas arrive".
const EVENEMENTS_ALERTE = new Set(['email.failed', 'email.bounced'])

// Lit le corps brut de la requete (Vercel ne l'a pas parse, cf. config ci-dessus).
function lireCorpsBrut(req) {
  return new Promise((resolve, reject) => {
    const morceaux = []
    req.on('data', c => morceaux.push(c))
    req.on('end', () => resolve(Buffer.concat(morceaux)))
    req.on('error', reject)
  })
}

// Verifie la signature Svix (le format utilise par Resend). Renvoie true si OK.
// Reutilisable tel quel pour tout autre webhook Resend/Svix.
function signatureValide(secret, headers, corpsBrut) {
  const svixId = headers['svix-id']
  const svixTimestamp = headers['svix-timestamp']
  const svixSignature = headers['svix-signature']
  if (!svixId || !svixTimestamp || !svixSignature) return false

  // Anti-rejeu : on refuse une requete trop vieille (tolerance 5 minutes).
  const age = Math.abs(Date.now() / 1000 - Number(svixTimestamp))
  if (!Number.isFinite(age) || age > 300) return false

  // Le secret a la forme "whsec_<base64>". La vraie cle est la partie base64 decodee.
  const cle = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')

  // Contenu signe = "id.timestamp.corps" (corps = le JSON brut, tel quel).
  const contenuSigne = `${svixId}.${svixTimestamp}.${corpsBrut.toString('utf8')}`
  const attendue = crypto.createHmac('sha256', cle).update(contenuSigne).digest('base64')
  const attendueBuf = Buffer.from(attendue)

  // L'en-tete peut contenir plusieurs signatures : "v1,<sig> v1,<sig> ...".
  // Comparaison en temps constant (timingSafeEqual) contre les attaques temporelles.
  return svixSignature.split(' ').some(part => {
    const sig = part.split(',')[1] || ''
    const sigBuf = Buffer.from(sig)
    return sigBuf.length === attendueBuf.length && crypto.timingSafeEqual(sigBuf, attendueBuf)
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })

  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return res.status(500).json({ error: 'RESEND_WEBHOOK_SECRET manquante sur Vercel' })

  const corpsBrut = await lireCorpsBrut(req)

  // 1) Securite : on ne traite que les requetes reellement signees par Resend.
  if (!signatureValide(secret, req.headers, corpsBrut)) {
    return res.status(401).json({ error: 'Signature invalide' })
  }

  // 2) On parse le JSON seulement APRES avoir valide la signature.
  let evenement
  try {
    evenement = JSON.parse(corpsBrut.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Corps JSON illisible' })
  }

  const type = evenement?.type
  const data = evenement?.data || {}

  // 3) On ne reagit qu'aux echecs. Tout le reste : 200 = "recu, rien a faire"
  //    (indispensable, sinon Resend reessaie l'envoi en boucle).
  if (!EVENEMENTS_ALERTE.has(type)) {
    return res.status(200).json({ ok: true, ignore: type })
  }

  // Garde anti-boucle : si c'est un mail d'alerte qui a lui-meme echoue, stop.
  const sujetEchoue = data.subject || ''
  if (sujetEchoue.includes(ALERTE_MARQUEUR)) {
    return res.status(200).json({ ok: true, boucle_evitee: true })
  }

  // 4) On construit l'alerte a partir de ce que Resend fournit (champs defensifs :
  //    la forme exacte varie selon failed / bounced).
  const destinataire = Array.isArray(data.to) ? data.to.join(', ') : data.to || 'inconnu'
  const raison =
    data.bounce?.message || data.reason || data.failed?.reason || 'raison non precisee par Resend'
  const quand = data.created_at || new Date().toISOString()

  const texte =
    `Un devis traiteur n'est PAS arrive.\n\n` +
    `Type d'echec  : ${type}\n` +
    `Destinataire  : ${destinataire}\n` +
    `Objet du devis: ${sujetEchoue || 'inconnu'}\n` +
    `Raison        : ${raison}\n` +
    `Quand         : ${quand}\n\n` +
    `Action : recontacter le client et renvoyer le devis manuellement.`

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERTE_FROM,
        to: ALERTE_TO,
        subject: `${ALERTE_MARQUEUR} Devis NON envoye — ${destinataire}`,
        text: texte,
      }),
    })
    // Meme si l'envoi de l'alerte echoue, on renvoie 200 : Resend n'a pas a
    // reessayer le webhook pour un souci de NOTRE mail d'alerte. On loggue juste.
    if (!r.ok) console.error('Envoi alerte KO :', await r.text())
  } catch (err) {
    console.error('Exception envoi alerte :', String(err))
  }

  return res.status(200).json({ ok: true, alerte: true })
}
