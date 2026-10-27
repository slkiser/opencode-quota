/** @jsxImportSource solid-js */
/**
 * The daily stacked area chart of the usage window and its model popup: one band per series,
 * the first at the bottom, with three value lines, the first, middle and last dates, and a
 * crosshair whose tooltip lists each series' value on the day under the pointer. Drawn as SVG
 * in a fixed coordinate box that scales to the width it gets.
 */
import { createSignal, For, Show } from "solid-js";
import { type ChartData, chartMax, niceMax } from "./usage-model.js";

type ChartProps = {
  chart: ChartData;
  width: number;
  height: number;
  /** A value as the axis and the tooltip write it. */
  format: (value: number) => string;
  /** A report day ("2026-10-27") on the axis ("Oct 27") and in the tooltip ("Tue, Oct 27"). */
  dateLabel: (date: string, long: boolean) => string;
  totalLabel: string;
};

const LEFT = 64;
const RIGHT = 4;
const TOP = 10;
const BOTTOM = 24;

export function Chart(props: ChartProps) {
  // An object, not the bare index: the first day's index, 0, would read as no hover.
  const [hover, setHover] = createSignal<{ index: number }>();
  const count = () => props.chart.dates.length;
  const plotWidth = () => props.width - LEFT - RIGHT;
  const plotHeight = () => props.height - TOP - BOTTOM;
  const top = () => niceMax(chartMax(props.chart));
  const x = (index: number) =>
    LEFT + (count() === 1 ? plotWidth() / 2 : (index / (count() - 1)) * plotWidth());
  const y = (value: number) => TOP + plotHeight() - (value / top()) * plotHeight();

  /** Each series' lower and upper edge, stacked on the ones before it. */
  const bands = () => {
    let below = props.chart.dates.map(() => 0);
    return props.chart.series.map((series) => {
      const lower = below;
      const upper = lower.map((value, index) => value + (series.values[index] ?? 0));
      below = upper;
      const points = (values: number[]) => values.map((value, index) => `${x(index)},${y(value)}`);
      const edge = `M${points(upper).join("L")}`;
      return {
        series,
        edge,
        area: `${edge}L${points(lower).reverse().join("L")}Z`,
      };
    });
  };
  const ticks = () => {
    const last = count() - 1;
    return [...new Set([0, Math.floor(last / 2), last])];
  };
  const tickAnchor = (index: number) =>
    count() === 1 ? "middle" : index === 0 ? "start" : index === count() - 1 ? "end" : "middle";

  const onMove = (event: MouseEvent) => {
    const box = (event.currentTarget as SVGRectElement).ownerSVGElement?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const scale = props.width / box.width;
    const plotX = (event.clientX - box.left) * scale - LEFT;
    const index = Math.round((plotX / plotWidth()) * (count() - 1));
    setHover({ index: Math.max(0, Math.min(count() - 1, index)) });
  };
  const total = (index: number) =>
    props.chart.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0);
  /** The tooltip sits right of the crosshair, or left of it near the right edge. */
  const tipStyle = (index: number) => {
    const share = x(index) / props.width;
    return share > 0.6 ? { right: `${(1 - share) * 100 + 2}%` } : { left: `${share * 100 + 2}%` };
  };

  return (
    <div class="oq-chart">
      <svg viewBox={`0 0 ${props.width} ${props.height}`} role="img">
        <For each={[0, 0.5, 1]}>
          {(fraction) => (
            <>
              <line
                class="oq-gridline"
                x1={LEFT}
                x2={props.width - RIGHT}
                y1={y(top() * fraction)}
                y2={y(top() * fraction)}
              />
              <text class="oq-axis" x={LEFT - 8} y={y(top() * fraction) + 3} text-anchor="end">
                {props.format(top() * fraction)}
              </text>
            </>
          )}
        </For>
        <For each={bands()}>
          {(band) => (
            <g class={`oq-c${band.series.color}`}>
              <path class="oq-area" d={band.area} />
              <path class="oq-edge" d={band.edge} />
            </g>
          )}
        </For>
        <For each={ticks()}>
          {(index) => (
            <text class="oq-axis" x={x(index)} y={props.height - 6} text-anchor={tickAnchor(index)}>
              {props.dateLabel(props.chart.dates[index] ?? "", false)}
            </text>
          )}
        </For>
        <Show when={hover()}>
          {(shown) => (
            <line
              class="oq-cross"
              x1={x(shown().index)}
              x2={x(shown().index)}
              y1={TOP}
              y2={TOP + plotHeight()}
            />
          )}
        </Show>
        <rect
          x={LEFT}
          y={TOP}
          width={plotWidth()}
          height={plotHeight()}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(undefined)}
        />
      </svg>
      <Show when={hover()}>
        {(shown) => (
          <div class="oq-tip" style={tipStyle(shown().index)}>
            <div class="oq-muted">
              {props.dateLabel(props.chart.dates[shown().index] ?? "", true)}
            </div>
            <For each={[...props.chart.series].reverse()}>
              {(series) => (
                <div class={`oq-tip-row oq-c${series.color}`}>
                  <span class="oq-dot" />
                  {series.name}
                  <b>{props.format(series.values[shown().index] ?? 0)}</b>
                </div>
              )}
            </For>
            <Show when={props.chart.series.length > 1}>
              <div class="oq-tip-row oq-tip-total">
                {props.totalLabel}
                <b>{props.format(total(shown().index))}</b>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
