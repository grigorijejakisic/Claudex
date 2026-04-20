# P1 stale review

## Heuristic matches (decision: stale unless flipped to keep)

- id=1 | status=stale | triggers=[Gemma 4 31B] | content="Angel generation is fully local (Gemma 4 31B Q6_K via llama-server on 127.0.0.1:8081). CliProxy was banned by Anthropic "
- id=3 | status=stale | triggers=[Gemma 4 31B, local llama-server] | content="Use local llama-server (Gemma 4 31B Q6_K) for Angel generation tasks. CliProxy and Ollama generation paths have been rem"
- id=7 | status=stale | triggers=[local llama-server] | content="v3.5 non-goals: do NOT touch the reranker (BGE-v2-m3 on :7439), sqlite-vec/vec0 tables, CC hook plumbing, Angel supervis"
- id=270 | status=stale | triggers=[Gemma 4 31B, local llama-server] | content="Angel generation runs on Ollama Cloud via the local daemon at 127.0.0.1:11434 (OpenAI-compat /v1/chat/completions), defa"
- id=271 | status=stale | triggers=[local llama-server] | content="Angel generation uses Ollama Cloud (default glm-5.1:cloud) routed through the local Ollama daemon on 127.0.0.1:11434. Ol"
- id=272 | status=stale | triggers=[Gemma 4 31B] | content="Angel generation is fully local — llama-server with Gemma 4 31B Q6_K on 127.0.0.1:8081. CliProxy was banned by Anthropic"
- id=275 | status=stale | triggers=[local llama-server] | content="Angel generation now uses Ollama cloud mode (glm-5.1:cloud) via daemon, not local llama-server. In cloud mode, superviso"
- id=276 | status=stale | triggers=[local llama-server] | content="Ollama is for both generation (cloud model glm-5.1:cloud) and embeddings. Local llama-server.exe is no longer spawned fo"
- id=437 | status=stale | triggers=[Gemma 4 31B, llama-server:8081, local llama-server] | content="context/specs/CLAUDEX_V4_SCOPE.md (session 51) — authoritative scope doc, 10 phases + P6.5 ablation gate, merges T5/I3/C"

## Manual additions (decision: stale)

<!-- add additional stale rows below -->
