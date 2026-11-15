import type { ReactNode } from "react";
import { Alert, Button, ButtonText, HStack, VStack } from "@titan-design/react-ui";
import { PHONE_TAP } from "../pages/phone.js";

/** A failed read's message with a Retry tap that asks the query again, so a phone need not reload the page. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <VStack gap={2}>
      <Alert status="error" message={message} />
      <HStack>
        <Button variant="outline" size="sm" className={PHONE_TAP} onPress={onRetry}>
          <ButtonText>Retry</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
