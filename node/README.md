# Tasks

```
```

# Bugs
```
1. cleanUpWebsiteMedia doesn't clean settings previous images
```

# Access Token
```
// GET COGNITO ACCESS TOKEN
TOKEN=`aws cognito-idp initiate-auth \
  --client-id 1qltt5stlpd1v26pi70cb2el0d \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=shukybadeer@gmail.com,PASSWORD=Shuky054@ \
  --profile default \
  --region us-east-1 \
  --query AuthenticationResult.AccessToken \
  --output text`
echo $TOKEN
```