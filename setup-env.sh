#!/bin/bash
# Secure .env setup — prompts for your API key so it never touches chat logs

cd "$(dirname "$0")"

echo ""
echo "All Star ABA — API Key Setup"
echo "------------------------------"
echo ""

# Check if .env exists, create from example if not
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "✅ Created .env from .env.example"
  else
    echo "❌ No .env.example found. Please create a .env file manually."
    exit 1
  fi
fi

# Generate JWT_SECRET if it's still the placeholder
if grep -q "JWT_SECRET=generate-a-long-random-string-here-min-32-chars" .env 2>/dev/null; then
  NEW_SECRET=$(openssl rand -hex 32)
  sed -i '' "s/JWT_SECRET=generate-a-long-random-string-here-min-32-chars/JWT_SECRET=$NEW_SECRET/" .env
  echo "✅ Generated random JWT_SECRET"
fi

# Prompt for API key (input is hidden)
echo ""
echo "Which AI provider are you using?"
echo "1) Anthropic (Claude)"
echo "2) OpenAI (GPT)"
echo ""
read -p "Enter 1 or 2: " provider

if [ "$provider" == "1" ]; then
  echo ""
  echo "Paste your Anthropic API key (input will be hidden):"
  read -s API_KEY
  echo ""
  if [ -z "$API_KEY" ]; then
    echo "❌ No key entered. Aborting."
    exit 1
  fi
  sed -i '' "s|ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$API_KEY|" .env
  echo "✅ Anthropic API key saved to .env"
elif [ "$provider" == "2" ]; then
  echo ""
  echo "Paste your OpenAI API key (input will be hidden):"
  read -s API_KEY
  echo ""
  if [ -z "$API_KEY" ]; then
    echo "❌ No key entered. Aborting."
    exit 1
  fi
  sed -i '' "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=$API_KEY|" .env
  echo "✅ OpenAI API key saved to .env"
else
  echo "❌ Invalid choice. Aborting."
  exit 1
fi

echo ""
echo "🚀 You're all set. Start the app with:"
echo "   ./start.sh -d"
echo "   Then open http://localhost:3000"
echo ""
