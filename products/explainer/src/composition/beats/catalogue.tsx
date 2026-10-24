import { Typography } from "@titan-design/react-ui";
import { FileCard, SchemaCard } from "@titan-design/react-ui/diagram";
import { Annotate, useBeatTime, type AnnotationBox } from "@titan-design/react-ui/motion";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { z } from "zod";

const FieldSlots = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  key: z.enum(["primary", "foreign"]).optional(),
});

const RefSlots = z.object({ table: z.string(), field: z.string() });

const SchemaSlots = z.object({
  tables: z.array(z.object({ id: z.string(), name: z.string(), fields: z.array(FieldSlots).min(1) })).min(1),
  relations: z.array(z.object({ id: z.string(), from: RefSlots, to: RefSlots })).optional(),
});

export const CatalogueSlots = z.object({
  file: z.object({
    path: z.string().min(1),
    loc: z.number().int().optional(),
    fanIn: z.number().int().optional(),
    fanOut: z.number().int().optional(),
  }),
  schema: SchemaSlots,
  schemaLabel: z.string().min(1),
  annotate: z.object({
    text: z.string().min(1),
    kind: z.enum(["highlight", "underline", "box", "circle", "strike-through", "crossed-off"]),
  }),
});

/**
 * Annotate measures through onLayout, which react-native-web reports from a ResizeObserver after the frame is
 * captured. Measuring in a layout effect lands inside the seek's flushSync commit, so the mark is in its own frame.
 */
function usePhraseBox(): [RefObject<HTMLDivElement | null>, AnnotationBox | undefined] {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<AnnotationBox>();
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    const h = ref.current?.offsetHeight ?? 0;
    if (w !== box?.w || h !== box?.h) setBox({ x: 0, y: 0, w, h });
  });
  return [ref, box];
}

/** One beat that shows react-ui's diagram and motion components live: a file card, a schema card and an annotation. */
export function CatalogueBeat({ slots }: { slots: z.infer<typeof CatalogueSlots> }) {
  const { t, progress } = useBeatTime();
  const [phrase, box] = usePhraseBox();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 48 }}>
      <Annotate kind={slots.annotate.kind} progress={progress} seed={slots.annotate.text} box={box} testID="catalogue-annotate">
        <div ref={phrase}>
          <Typography variant="h2">{slots.annotate.text}</Typography>
        </div>
      </Annotate>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 64 }}>
        <FileCard {...slots.file} />
        <SchemaCard data={slots.schema} t={t} accessibilityLabel={slots.schemaLabel} />
      </div>
    </div>
  );
}
