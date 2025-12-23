curl https://api.minimax.io/v1/chat/completions \
  -H "Authorization: Bearer $MINIMAX_API_KEY" \                  
  -H "Content-Type: application/json" \
  -d '{
    "model": "MiniMax-M2",
    "messages": [     
      {
        "role": "user",
        "content": "Hello, world"
      }
    ],
    "max_tokens": 1024
  }'
