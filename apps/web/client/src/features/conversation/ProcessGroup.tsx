import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { Icon } from "../../ui";
import { type ProcessGroup as ProcessGroupData, processGroupSummary } from "./process-groups";
import { ThinkingDisclosure, ThinkingElapsed } from "./ThinkingDisclosure";
import { ToolRow } from "./ToolCall";

/** Fixed DFSC Simple default; no preset state, runtime authority or automatic expansion. */
export const ProcessGroup = memo(function ProcessGroup({
	group,
	revealEntryId,
}: {
	readonly group: ProcessGroupData;
	readonly revealEntryId?: string;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const single = group.rows.length === 1;
	const triggerRef = useRef<HTMLButtonElement>(null);
	// Keep a focused heading visible until its remaining member can receive focus.
	const [triggerFocused, setTriggerFocused] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);
	const id = useId();
	const containsReveal = Boolean(
		revealEntryId && group.rows.some(({ item }) => item.kind === "thinking" && item.entryId === revealEntryId),
	);
	const open = single || expanded || containsReveal;
	useLayoutEffect(() => {
		if (containsReveal) setExpanded(true);
	}, [containsReveal]);
	useLayoutEffect(() => {
		if (single && document.activeElement === triggerRef.current) {
			bodyRef.current?.querySelector<HTMLButtonElement>(".thinking-summary, .tool-toggle")?.focus({
				preventScroll: true,
			});
		}
	}, [single]);
	const { label, detail, icon } = processGroupSummary(group, t);
	// A single thought's observed duration stays visible even while its process is folded.
	const thoughts = group.rows.map(({ item }) => item).filter((item) => item.kind === "thinking");
	const thought = thoughts.length === 1 ? thoughts[0] : undefined;
	return (
		<section
			className="process-tool-group compact-process"
			data-process-key={group.key}
			data-running={group.running}
			data-single={single}
		>
			<button
				ref={triggerRef}
				type="button"
				hidden={single && !triggerFocused}
				onFocus={() => setTriggerFocused(true)}
				onBlur={() => setTriggerFocused(false)}
				className={`tool-group-trigger tool-row${group.running ? " pending" : ""}`}
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setExpanded((value) => !value)}
			>
				<Icon name={icon} size="xs" />
				<span className="tool-verb">
					{label}
					<span className="tool-pending" data-label={label} aria-hidden="true" />
				</span>
				{thought && !single ? (
					<ThinkingElapsed
						timing={thought.timing}
						active={group.running && thought.running}
						labelKey="processThinkingElapsed"
					/>
				) : null}
				<Icon name="disclosure" size="xs" className="tool-group-chevron" />
				{!open && detail ? <span className="process-group-preview">{detail}</span> : null}
			</button>
			<div id={id} className={`tool-group-disclosure${open ? " expanded" : ""}`} aria-hidden={!open} inert={!open}>
				<div ref={bodyRef} className="tool-group-body">
					{group.rows.map(({ key, item }) =>
						item.kind === "thinking" ? (
							<ThinkingDisclosure
								key={key}
								item={item}
								active={group.running}
								onExpandedChange={single ? setExpanded : undefined}
							/>
						) : (
							<ToolRow key={key} item={item} onExpandedChange={single ? setExpanded : undefined} />
						),
					)}
				</div>
			</div>
		</section>
	);
});
