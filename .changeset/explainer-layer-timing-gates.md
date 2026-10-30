---
"@titan-design/explainer": patch
---

The custom-layer build check now runs qa's beat-local timing gates on each layer (TP-4611): static-window, picture-change, reading-hold and G9, from qa's own functions, over the layer's frames at ten a second. It plays the beat at its speech band's rate and truing's length, because tts runs after resolve and the plan's seconds misread the stretch after a beat's last cue. A finding joins the one rebuild and names the stretch. As in qa, a custom layer gets no settled-speech allowance. The custom-layer doctrine says so, which re-keys cached layer builds so they meet the new check. resolve moves to `p5c2s2f2s2d12`.
