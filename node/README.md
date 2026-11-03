# Ceseelia API (node)

See `../CLAUDE.md` for architecture, conventions and the roadmap.

## Setup

```bash
cp .env.example .env   # adjust values; never commit .env
npm install
npm run dev
```

## Getting a Cognito access token for manual testing

```bash
read -rp "Email: " EMAIL; read -rsp "Password: " PASSWORD; echo
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id "$COGNITO_USER_POOL_CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" \
  --region us-east-1 \
  --query AuthenticationResult.AccessToken \
  --output text)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/v1/user/get-my-profile
```

The app client must allow the `USER_PASSWORD_AUTH` flow.

## Known bugs

1. `cleanUpWebsiteMedia` doesn't clean settings previous images (legacy note).
