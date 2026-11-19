# Facebook and Instagram lead ads into WehdatHub (direct webhook)

Meta sends each new lead to WehdatHub. No middleman. The owner pastes one Page access token per agency.

## One time: the Meta app

1. In the Meta app (the same app as WhatsApp), add the **Webhooks** product.
2. Choose the **Page** object. Callback URL: `<PUBLIC_BASE_URL>/webhook/leadgen`.
   Verify token: the value of `WHATSAPP_VERIFY_TOKEN`. Meta signs each call with the app secret (`WHATSAPP_APP_SECRET`); WehdatHub checks that signature.
3. Subscribe to the field **leadgen**.
4. The app needs the permissions `pages_show_list`, `pages_manage_metadata`, `leads_retrieval`, `pages_read_engagement`.
   For Pages that are not owned by the app's own business, these need **Advanced access** (App Review) and Business verification.
   While the app is in development mode, only people with a role on the app, and Pages they manage, work.

## Per agency (about 10 minutes)

1. **Agency:** in Meta Business Suite, give the owner's Facebook account access to the Page with **Leads** access
   (Page settings → Page access, or Business settings → Pages → assign people).
   If Leads Access Manager is restricted (Business settings → Integrations → Leads access), allow the app as a CRM.
2. **Owner:** create a long-lived **Page access token** for that Page with the four permissions above
   (Graph API Explorer: get a user token, exchange it for a long-lived one, then `GET /me/accounts` returns the Page token and Page ID).
3. **Owner, on /app/owner, tab "Facebook leads":** pick the agency, name it, source **Facebook**,
   Page ID, paste the Page access token, quiet days 3, press **Connect Page**.
   WehdatHub checks the token with Graph and subscribes the Page to `leadgen`. The token is stored encrypted and never shown again (only its last 4 characters).
4. **Check:** press **Test** (it asks Graph if the token works and the Page is subscribed; it saves nothing). Then send a lead from Meta's
   [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing) and check it reaches a broker (Telegram alert).

## What happens to a lead

Meta calls `POST /webhook/leadgen` with the lead id. WehdatHub fetches the lead from Graph with the Page token, and the lead goes through the normal rules:
same phone is merged (the broker is told), the intake's source is used (Instagram when Meta says so), the next broker in the round robin gets it, managers get the new-lead alert.
The same lead id twice is taken once. Every lead is in the intake log without the phone (last 4 digits only).
If Graph fails, the log shows a temporary error and the lead is not saved; ask the agency to export the lead from Meta's leads center.

## Key setup (once)

Set `TOKEN_ENCRYPTION_KEY` in Render (32 random bytes, base64): `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Page tokens are stored encrypted with it (AES-256-GCM). Without it, production refuses to connect a Page.
**Rotation:** changing the key makes the stored tokens unreadable. After a change, press **Update token** on every Page and paste its token again.
Older tokens stored in plain text still work and are encrypted the next time the token is updated.

## When a connection stops

Every call to Facebook carries a proof made with the app secret (`appsecret_proof`). If Facebook says the token is dead, the intake is marked **disconnected**:
WehdatHub stops calling Facebook for it, tells the owner on Telegram and the agency's managers in the app (once), and shows a red banner on `/app/sources` and `/app/owner`.
Leads that arrive while it is down are not saved (the log shows "disconnected"); ask the agency to download them from Meta's leads center.

| Facebook says | Reason shown | What WehdatHub does | What the person does |
| :--- | :--- | :--- | :--- |
| 190 / 460 | Password changed | Disconnects, alerts once | Agency asks WehdatHub support to reconnect. Owner: new token, **Update token**. |
| 190 / 492 | Removed from the Page, or lost access | Disconnects, alerts once | Give the person Page access again (or use another admin), then new token, **Update token**. |
| 190 / 459 | Facebook needs the person to confirm identity | Disconnects, alerts once | The person logs in to Facebook and confirms; new token, **Update token**. |
| 190 / 463, 467, or none | Token expired or invalid | Disconnects, alerts once | New token, **Update token**. |
| 10, 200, 283 | Permission missing | Disconnects, alerts once | Give the Leads permission on the Page and in the app, new token, **Update token**. |
| 4, 17, 32, 613 (rate limit), 5xx, no network | Temporary | Retries once, then logs an error row. Never disconnects, no alert | Nothing. If it repeats, check the Facebook leads tab. |
| Other (for example lead not found) | Error row in the log | Logs it, no retry | Nothing, unless it repeats. |

**Update token** (the reconnect path, on the Facebook leads tab): paste the new Page token, WehdatHub checks it, subscribes the Page again and sets the intake active.
**Test** on a disconnected intake also sets it active when it passes. A Page stopped on purpose uses **Revoke**, which deletes the token and unsubscribes the Page.

## Token expiry

Page tokens made from a long-lived user token do not expire by time, but stop working when the user changes their password,
loses Page access, or removes the app. The quiet-days alert still works for an active intake; a disconnected one alerts through the path above.

## Troubleshooting

* Meta refuses the callback URL: check `PUBLIC_BASE_URL` is https and `WHATSAPP_VERIFY_TOKEN` matches.
* Nothing arrives for a real Page but the testing tool works: the app is missing Advanced access for that Page.
* 401 in the Meta webhook log: `WHATSAPP_APP_SECRET` is wrong.
