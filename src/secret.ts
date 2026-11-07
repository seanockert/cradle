// Webhook secret = sha256("cradle-gh:" + TOKEN). Worker and CLI derive it, so there is no second secret to manage.
export async function webhookSecret(token: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cradle-gh:${token}`))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
