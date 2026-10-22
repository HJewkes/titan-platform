---
"titan-console": patch
---

Stop a round question's card from moving under a press. The card was a pressable Card, whose press scale and hover lift held while any radio or text field inside it was pressed, so a tap could slide the radio away before it registered and typing a space nudged the card. A click anywhere in the card still makes it the active question; only buttons keep their press.
