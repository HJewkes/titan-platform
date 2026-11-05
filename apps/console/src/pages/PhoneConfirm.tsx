import { useState, type ReactNode } from "react";
import { Button, ButtonText, Card, CardContent, HStack, Typography, VStack } from "@titan-design/react-ui";
import { useMediaQuery } from "./FramePins.js";
import { BELOW_MD, PHONE_TAP } from "./phone.js";

/** An owner write a press sends. `isDisabled` is read at each render, so a step armed before it went off closes. */
interface ConfirmAction {
  id: string;
  /** The confirm button's label, such as "Confirm Ship". */
  confirm: string;
  /** What the write does, in the owner's words, shown above the confirm. */
  detail: string;
  isDisabled: boolean;
  run: () => void;
}

/**
 * On a phone a thumb lands on Ship while scrolling, so a write press only arms a confirm step and the write goes on its
 * Confirm; a desktop press writes at once, as before.
 */
export function useConfirmOnPhone(actions: readonly ConfirmAction[]): { press: (id: string) => void; step: ReactNode } {
  const phone = useMediaQuery(BELOW_MD);
  const [armedId, setArmedId] = useState<string>();
  const armed = phone ? actions.find((action) => action.id === armedId && !action.isDisabled) : undefined;
  const press = (id: string): void => {
    const action = actions.find((candidate) => candidate.id === id);
    if (action === undefined || action.isDisabled) return;
    if (phone) setArmedId(id);
    else action.run();
  };
  const confirm = (action: ConfirmAction): void => {
    setArmedId(undefined);
    action.run();
  };
  const step = armed ? <ConfirmStep action={armed} onConfirm={() => confirm(armed)} onCancel={() => setArmedId(undefined)} /> : null;
  return { press, step };
}

function ConfirmStep({ action, onConfirm, onCancel }: { action: ConfirmAction; onConfirm: () => void; onCancel: () => void }): ReactNode {
  return (
    <Card variant="subtle" testID="phone-confirm">
      <CardContent>
        <VStack gap={2}>
          <Typography variant="body2" className="break-words">{action.detail}</Typography>
          <HStack gap={3} wrap>
            <Button color="primary" className={PHONE_TAP} onPress={onConfirm} testID="phone-confirm-go"><ButtonText>{action.confirm}</ButtonText></Button>
            <Button variant="outline" color="secondary" className={PHONE_TAP} onPress={onCancel} testID="phone-confirm-cancel"><ButtonText>Cancel</ButtonText></Button>
          </HStack>
        </VStack>
      </CardContent>
    </Card>
  );
}
