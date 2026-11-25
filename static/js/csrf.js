let token = "";
let expiresAt = 0;

export async function getCsrfToken() {
  if (token && Date.now() < expiresAt - 30_000) return token;

  const response = await fetch("/api/auth/csrf");
  if (!response.ok) throw new Error("Не удалось проверить сессию");

  const data = await response.json();
  token = data.csrf;
  expiresAt = Number(token.split(".")[0]) * 1000;
  return token;
}
