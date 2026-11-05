// Public settings for the site. Nothing here is secret.

// Client ID of your Hugging Face OAuth app (Settings -> Connected Apps -> your app).
// A public "no secret" app only needs this ID. Leave empty to hide the sign-in button.
export const HF_CLIENT_ID = "6f5e95c5-52c4-40fb-a1bb-856c1d703b34";

// Keep scopes minimal: the token sits in the visitor's browser, so it should
// only be able to identify the visitor, not touch their repos or billing.
export const HF_SCOPES = "openid profile";
