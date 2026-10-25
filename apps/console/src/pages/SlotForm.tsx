import type { ReactNode } from "react";
import { Button, ButtonText, Checkbox, HStack, Input, Select, Typography, VStack } from "@titan-design/react-ui";
import { addRow, canAddRow, canRemoveRow, isFields, moveRow, removeRow, type Control, type Field, type Fields } from "./slot-form.js";

type ArrayControl = Extract<Control, { kind: "array" }>;

/** What every control below the root shares: the beat's locked ids, its taken ids and the problems placed by path. */
interface FormContext {
  locked: readonly string[];
  taken: ReadonlySet<string>;
  problems: ReadonlyMap<string, readonly string[]>;
}

interface NodeProps {
  path: string;
  label: string;
  control: Control;
  value: unknown;
  onChange: (value: unknown) => void;
  context: FormContext;
  /** Set on a row's `id` field when a cue targets that id, so it reads but never changes. */
  readOnly?: boolean;
}

const testIdOf = (path: string): string => `slot-${path.replaceAll(".", "-")}`;
const problemText = (context: FormContext, path: string): string | undefined => context.problems.get(path)?.join("; ");

/**
 * The app-local form a beat's slot JSON Schema renders as; TD-1031 moves it into react-ui as SchemaForm. Each field
 * replaces its value whole, so the form hands the root a new object on every change.
 */
export function SlotForm({ fields, value, onChange, locked, taken, problems }: { fields: readonly Field[]; value: Fields; onChange: (value: Fields) => void } & FormContext): ReactNode {
  const context: FormContext = { locked, taken, problems };
  return (
    <VStack gap={3} className="w-full min-w-0" testID="slot-form">
      {fields.map((field) => (
        <SlotNode key={field.name} path={field.name} label={field.name} control={field.control} value={value[field.name]} onChange={(next) => onChange({ ...value, [field.name]: next })} context={context} />
      ))}
    </VStack>
  );
}

function SlotNode(props: NodeProps): ReactNode {
  switch (props.control.kind) {
    case "text":
      return <TextField {...props} control={props.control} />;
    case "number":
      return <NumberField {...props} />;
    case "select":
      return <SelectField {...props} options={props.control.options} />;
    case "boolean":
      return <Checkbox label={props.label} isChecked={props.value === true} onCheckedChange={(checked: boolean) => props.onChange(checked)} testID={testIdOf(props.path)} />;
    case "object":
      return <ObjectField {...props} fields={props.control.fields} />;
    case "array":
      return <ArrayField {...props} control={props.control} />;
    default:
      return <RawField {...props} />;
  }
}

function TextField({ path, label, control, value, onChange, context, readOnly }: NodeProps & { control: Extract<Control, { kind: "text" }> }): ReactNode {
  const text = typeof value === "string" ? value : "";
  const over = control.maxLength !== undefined && text.length > control.maxLength;
  const counter = control.maxLength === undefined ? undefined : `${text.length}/${control.maxLength}`;
  const problem = problemText(context, path);
  const helper = readOnly ? "a cue targets this id, so it stays" : counter;
  return (
    <Input
      label={label}
      accessibilityLabel={path}
      value={text}
      onChangeText={onChange}
      isReadOnly={readOnly === true}
      isInvalid={over || problem !== undefined}
      {...(helper === undefined ? {} : { helperText: helper })}
      {...(problem === undefined ? {} : { errorMessage: counter === undefined ? problem : `${counter} · ${problem}` })}
      className="w-full min-w-0"
      testID={testIdOf(path)}
    />
  );
}

/** Text the owner is still typing ("1.", "-") stays text, so the edit check names it rather than the form eating it. */
function NumberField({ path, label, value, onChange, context }: NodeProps): ReactNode {
  const problem = problemText(context, path);
  const parse = (text: string): unknown => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text);
  return (
    <Input label={label} accessibilityLabel={path} value={value === undefined ? "" : String(value)} onChangeText={(text: string) => onChange(parse(text))} isInvalid={problem !== undefined} {...(problem === undefined ? {} : { errorMessage: problem })} className="w-full min-w-0" testID={testIdOf(path)} />
  );
}

function SelectField({ path, label, value, onChange, context, options }: NodeProps & { options: readonly string[] }): ReactNode {
  const problem = problemText(context, path);
  return (
    <VStack gap={1} className="w-full min-w-0">
      <Typography variant="caption" color="secondary">{label}</Typography>
      <Select<string> value={typeof value === "string" ? value : null} options={options.map((option) => ({ value: option, label: option }))} onChange={(next) => next !== null && onChange(next)} isInvalid={problem !== undefined} className="w-full max-w-full" testID={testIdOf(path)} />
      {problem === undefined ? null : <Typography variant="caption" color="error">{problem}</Typography>}
    </VStack>
  );
}

function ObjectField({ path, label, value, onChange, context, fields }: NodeProps & { fields: readonly Field[] }): ReactNode {
  const object = isFields(value) ? value : {};
  const lockedId = typeof object.id === "string" && context.locked.includes(object.id);
  return (
    <VStack gap={2} className="w-full min-w-0" testID={testIdOf(path)}>
      {label === "" ? null : <Typography variant="subtitle2">{label}</Typography>}
      {fields.map((field) => (
        <SlotNode key={field.name} path={`${path}.${field.name}`} label={field.name} control={field.control} value={object[field.name]} onChange={(next) => onChange({ ...object, [field.name]: next })} context={context} readOnly={field.name === "id" && lockedId} />
      ))}
    </VStack>
  );
}

function ArrayField({ path, label, control, value, onChange, context }: NodeProps & { control: ArrayControl }): ReactNode {
  const rows = Array.isArray(value) ? value : [];
  const problem = problemText(context, path);
  const bounds = Number.isFinite(control.maxItems) ? `${rows.length} of ${control.minItems}-${control.maxItems}` : `${rows.length}, at least ${control.minItems}`;
  return (
    <VStack gap={2} className="w-full min-w-0" testID={testIdOf(path)}>
      <Typography variant="subtitle2">{`${label} (${bounds} rows)`}</Typography>
      {problem === undefined ? null : <Typography variant="caption" color="error">{problem}</Typography>}
      {rows.map((row, index) => (
        <VStack key={index} gap={2} className="w-full min-w-0 rounded border border-divider p-2">
          <SlotNode path={`${path}.${index}`} label="" control={control.item} value={row} onChange={(next) => onChange(rows.map((each, i) => (i === index ? next : each)))} context={context} />
          <RowButtons path={`${path}.${index}`} index={index} rows={rows} control={control} onChange={onChange} locked={context.locked} />
        </VStack>
      ))}
      <Button size="sm" variant="outline" onPress={() => onChange(addRow(rows, control, context.taken))} isDisabled={!canAddRow(rows, control)} className="max-w-full self-start" testID={`${testIdOf(path)}-add`}>
        <ButtonText>Add row</ButtonText>
      </Button>
    </VStack>
  );
}

interface RowButtonsProps {
  path: string;
  index: number;
  rows: readonly unknown[];
  control: ArrayControl;
  onChange: (rows: unknown[]) => void;
  locked: readonly string[];
}

function RowButtons({ path, index, rows, control, onChange, locked }: RowButtonsProps): ReactNode {
  const id = testIdOf(path);
  return (
    <HStack gap={2} wrap className="max-w-full">
      <Button size="sm" variant="ghost" onPress={() => onChange(moveRow(rows, index, index - 1))} isDisabled={index === 0} className="max-w-full" testID={`${id}-up`}>
        <ButtonText>Up</ButtonText>
      </Button>
      <Button size="sm" variant="ghost" onPress={() => onChange(moveRow(rows, index, index + 1))} isDisabled={index === rows.length - 1} className="max-w-full" testID={`${id}-down`}>
        <ButtonText>Down</ButtonText>
      </Button>
      <Button size="sm" variant="ghost" color="error" onPress={() => onChange(removeRow(rows, index, control, locked))} isDisabled={!canRemoveRow(rows, index, control, locked)} className="max-w-full" testID={`${id}-remove`}>
        <ButtonText>Remove</ButtonText>
      </Button>
    </HStack>
  );
}

/** A node the form has no control for (a tuple, a record, a union) shows its value; the script is where it changes. */
function RawField({ path, label, value }: NodeProps): ReactNode {
  return (
    <VStack gap={1} className="w-full min-w-0" testID={testIdOf(path)}>
      <Typography variant="caption" color="secondary">{label}</Typography>
      <Typography variant="body2" className="break-all font-mono">{value === undefined ? "—" : JSON.stringify(value)}</Typography>
    </VStack>
  );
}
