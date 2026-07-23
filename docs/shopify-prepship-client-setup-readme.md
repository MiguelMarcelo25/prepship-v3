# Connect Shopify to PrepShip

Last verified: 2026-07-18

Use this guide when a new PrepShip customer needs to connect a Shopify store.
It covers the recommended Shopify Dev Dashboard setup, the legacy Admin API
token path for stores that already have an admin-created custom app, Client
Portal submission, and PrepShip operator verification.

## What the connection does

After the connection is approved, PrepShip can:

- pull recent Shopify orders into PrepShip;
- keep Shopify order and fulfillment-order facts available for shipping;
- show eligible Shopify orders in Awaiting Shipment;
- push tracking and fulfillment updates back to Shopify; and
- use Shopify Shipping workflows when the store, order, permissions, and
  PrepShip feature controls allow them.

Shopify is the order source. Carrier rates and labels can still come from the
carrier accounts configured in PrepShip.

## Before you start

You need:

- the Shopify store owner's approval;
- permission to create/install apps and assign Admin API scopes;
- the store's permanent `.myshopify.com` domain, for example
  `your-store.myshopify.com`; and
- access to either the PrepShip Client Portal or PrepShip Settings.

Do not use the store's public custom domain such as `your-store.com`.

## Protect the credentials

Client secrets and Admin API access tokens are passwords.

- Enter them only in the secure PrepShip or Client Portal credential form.
- Never paste them into Trello, email, Slack, support chat, source code, a URL,
  or a screenshot.
- Never send a screenshot that shows a revealed secret or token.
- If a credential is exposed, rotate or revoke it in Shopify before continuing.
- PrepShip must never display the saved secret after submission.

Use placeholders such as `<SHOPIFY_CLIENT_SECRET>` in documentation and
support notes. Do not put a real credential in a ticket.

## Required Shopify Admin API scopes

Configure this full scope set for the PrepShip connection:

```text
read_customers
read_draft_orders
read_fulfillments
write_fulfillments
read_locations
read_merchant_managed_fulfillment_orders
write_merchant_managed_fulfillment_orders
read_orders
write_orders
read_products
```

This is the full connection contract used by the current Client Portal and
Shopify workflows. It covers order/customer fields, products and locations,
fulfillment-order access, tracking/fulfillment writes, and Shopify Shipping
rate/label operations. PrepShip's `Shipping Check` separately reports the
smaller label-readiness subset and any store/order-specific blockers.

Do not add unrelated scopes unless PrepShip support identifies a specific
workflow that needs one.

## Path A - Shopify Dev Dashboard app (recommended)

Use this path for a new setup. Shopify's client-credentials flow requires the
app and target store to belong to the same Shopify organization.

1. Sign in to the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
   using the store owner's organization.
2. Open `Apps`, then create a new app or open the store's existing PrepShip
   app.
3. Name it clearly, for example `PrepShip - <CUSTOMER_NAME>`.
4. If Shopify asks for an App URL, use:

   ```text
   https://prepshipv4.vercel.app
   ```

5. Configure the Admin API scopes using the exact list in
   [Required Shopify Admin API scopes](#required-shopify-admin-api-scopes).
6. Create or update the app version, then select `Release`.
7. From the app's Home page, select `Install app` and install it on the exact
   target store.
8. Open the app's `Settings` page and copy:

   ```text
   Client ID: <SHOPIFY_CLIENT_ID>
   Client secret: <SHOPIFY_CLIENT_SECRET>
   ```

9. Keep the secret private. PrepShip exchanges the Client ID and secret on the
   backend for a short-lived Shopify access token and refreshes it when needed.

Scope changes do not automatically update an existing installation. After
changing scopes, release the new app version and reinstall or update the app on
the target store before testing again.

## Path B - existing Shopify-admin custom app (legacy only)

Use this path only if the store already has an admin-created custom app with a
real Admin API access token. Shopify no longer allows new admin-created custom
apps, but existing ones can continue to work.

1. In Shopify Admin, open the store's existing custom app.
2. Confirm its Admin API scopes include the full list in
   [Required Shopify Admin API scopes](#required-shopify-admin-api-scopes).
3. Install or reinstall the app after any scope change.
4. Reveal and copy the Admin API access token. A real token normally begins
   with `shpat_`:

   ```text
   Admin API access token: <SHOPIFY_ADMIN_API_ACCESS_TOKEN>
   ```

5. Enter that token only in the `Admin API Access Token` field. Do not paste a
   Client secret into the token field.

If the store does not already have this legacy app/token, use Path A.

## Connect through the PrepShip Client Portal

1. Sign in to the Client Portal.
2. Open `Connections` and select `Add store`.
3. Choose `Shopify`.
4. Enter a recognizable store name and the permanent shop domain:

   ```text
   Store name: <CUSTOMER_OR_STORE_NAME>
   Shop domain: your-store.myshopify.com
   ```

5. For Path A, enter the Shopify `Client ID` and `Client secret`.
6. If the portal presents the legacy-token form and the store qualifies for
   Path B, enter the real `shpat_` Admin API access token instead.
7. Review the masked credential summary, then select `Connect store`.

The backend validates the shop and required scopes before accepting the
request. A successful submission appears as `Pending` or `Awaiting operator
activation`. This is expected: submitted credentials remain inactive until a
PrepShip operator reviews and approves the connection.

## Connect through PrepShip Settings

An authorized PrepShip operator can connect or approve the store directly.

1. Open `Settings` and go to the store integrations section.
2. Select `Add Store`, then choose `Shopify`.
3. Enter:

   ```text
   Shop Domain: your-store.myshopify.com
   Client ID: <SHOPIFY_CLIENT_ID>                       # Path A
   Client Secret: <SHOPIFY_CLIENT_SECRET>               # Path A
   Admin API Access Token: <SHOPIFY_ADMIN_API_TOKEN>    # Path B only
   API Version:                                         # leave blank unless support says to pin it
   ```

4. Use either Client ID/Secret or the legacy token, not both. When both are
   present, PrepShip prefers Client ID/Secret.
5. Assign the integration to the correct PrepShip client.
6. Save the integration.

The current backend defaults to Shopify Admin API version `2026-07`. Leaving
the optional API Version field blank is preferred unless PrepShip support asks
you to pin a version.

## Verify the connection

Complete these checks in order.

### 1. Test Connection

Select `Test Connection` on the Shopify row.

Success criteria:

- the result is green;
- the result shows `Connected` or the correct Shopify shop name; and
- the saved account identifier is the expected `.myshopify.com` domain.

This check is read-only. It verifies the saved credentials by reading Shopify
shop metadata; it does not pull orders or buy postage.

### 2. Pull Orders

Select `Pull Orders`.

Success criteria:

- the result reports fetched/new/updated counts without a red error;
- the result reports how many orders were mirrored to Awaiting Shipment; and
- a recent eligible test order appears once under the correct PrepShip client
  with the expected recipient, items, quantity, total, and weight.

A successful result with `0 fetched` is not automatically a connection
failure. Confirm that the store has a recent unfulfilled order in the pull
window before troubleshooting credentials.

### 3. Shipping Check

Select `Shipping Check` when Shopify Shipping readiness is part of the setup.
This check reads scopes and an open fulfillment order without purchasing a
label.

Success criteria:

- no required scope is reported missing;
- an eligible open Shopify fulfillment order can be resolved; and
- any remaining message is an explicit store/order/feature-control blocker,
  not a credential error.

Do not buy a real label merely to test the connection. Use a separately
approved low-risk order and label test when live-postage testing is required.

## Troubleshooting

### `app_not_installed`

The credentials reached Shopify, but the app is not installed on the exact shop
domain entered in PrepShip.

- Confirm the `.myshopify.com` domain.
- Install or reinstall the app on that store.
- Retest the connection.

### `shop_not_permitted` or client-credentials grant rejected

The app and store might not belong to the same Shopify organization.

- Open the Shopify Dev Dashboard organization that owns the store.
- Confirm both the app and store appear under that organization.
- Create/install the app from the store owner's organization, then retry.

### Missing scope(s)

- Add every scope listed in this guide.
- Release a new app version.
- Reinstall or update the app on the target store.
- Retest. Editing the scope list alone does not update the installed grant.

### Invalid API key, token, or credentials

- Do not send the Client ID or Client secret directly as an API access token.
- Path A requires both Client ID and Client secret.
- Path B requires a real Admin API access token, normally beginning `shpat_`.
- Re-copy the value from Shopify and check for leading/trailing spaces.
- Rotate the secret/token if it may have been exposed.

### Test Connection works but Pull Orders returns zero

- Create or locate a recent unfulfilled Shopify order.
- Confirm the order has a shipping address and shippable line items.
- Run `Pull Orders` again.
- If the result still shows zero, provide PrepShip support the shop domain,
  timestamp, and non-secret error text. Never include credentials.

### Pull Orders works but Shipping Check fails

The credentials can read orders, but shipping has an additional scope,
permission, fulfillment-order, or feature-control blocker. Follow the exact
`Shipping Check` message. Shopify label purchase also requires a Shopify user
with the `buy_shipping_labels` permission and accepted Shopify Shipping terms.

## Safe handoff record

Record only non-secret evidence in the customer ticket:

```text
Customer: <CUSTOMER_NAME>
Shop domain: your-store.myshopify.com
Credential path: Dev Dashboard client credentials | existing admin custom app
Test Connection: PASS | FAIL
Pull Orders: <FETCHED> fetched, <NEW> new, <UPDATED> updated, <MIRRORED> mirrored
Shipping Check: PASS | NOT REQUIRED | BLOCKED: <NON_SECRET_REASON>
Operator approval: <NAME_AND_DATE>
```

Never record the Client secret or Admin API access token.

## Official Shopify references

- [Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)
- [Use the client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
- [Existing admin-created custom app access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin)
- [Admin API access scopes](https://shopify.dev/docs/api/admin-rest/usage/access-scopes)
- [Shopify Shipping label purchase requirements](https://shopify.dev/changelog/label-purchase-mutation)
