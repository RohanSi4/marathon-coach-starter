/**
 * Use this if STRAVA_REFRESH_TOKEN ever stops working (i.e. you revoke access in Strava settings).
 * Run: npm run strava-reauth
 * Steps:
 *   1. Opens the Strava auth URL — paste it into your browser
 *   2. After clicking "Authorize", copy the `code=...` param from the redirect URL
 *   3. Paste it here → prints your new refresh token → update .env.local
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import * as readline from "readline";

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost/exchange_token"; // Strava requires a URI but we never hit it

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set in .env.local");
  process.exit(1);
}

const authUrl = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&approval_prompt=force&scope=activity:read_all`;

console.log("\n1. Open this URL in your browser:\n");
console.log("  " + authUrl);
console.log("\n2. Click Authorize. You'll be redirected to a URL that won't load.");
console.log("   Copy the full redirect URL from your browser address bar.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the redirect URL (or just the code= value): ", async (input) => {
  rl.close();

  const code = input.includes("code=")
    ? new URL(input.replace("http://localhost/", "http://localhost/?")).searchParams.get("code")
    : input.trim();

  if (!code) {
    console.error("Could not extract code from input.");
    process.exit(1);
  }

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }),
  });

  if (!res.ok) {
    console.error("Token exchange failed:", await res.text());
    process.exit(1);
  }

  const data = await res.json() as { refresh_token: string; athlete?: { firstname: string; lastname: string } };
  console.log(`\nConnected as: ${data.athlete?.firstname} ${data.athlete?.lastname}`);
  console.log("\nNew STRAVA_REFRESH_TOKEN:");
  console.log("  " + data.refresh_token);
  console.log("\nUpdate .env.local → STRAVA_REFRESH_TOKEN=" + data.refresh_token + "\n");
});
