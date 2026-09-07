/**
 * Charts, drawn as SVG from a small JSON spec.
 *
 * There are two ways to get a picture out of a local model, and Reflect uses
 * both. This is the reliable one: the model writes a handful of labels and
 * numbers, and *we* do the drawing, so a 4B model that cannot be trusted to
 * emit working JavaScript can still produce a correct chart. The other way is
 * an `html` block in the sandbox, for when the model wants to build something
 * we did not anticipate.
 *
 * The spec, kept small enough that a small model gets it right:
 *
 * ```chart
 * {"type":"bar","title":"Tokens per second",
 *  "data":[{"label":"gemma","value":11.7},{"label":"ornith","value":4.5}]}
 * ```
 *
 * `type` is bar, line, area, or pie. `data` is labels and values. Everything
 * else — title, unit, colours, axis labels — is optional, because a model that
 * has to remember eight fields will get one of them wrong.
 *
 * Labels are text from a model, so every one of them is escaped on the way into
 * the SVG. Pure string in, string out; it runs in the tests with no DOM.
 */

import { escapeHtml } from './markdown.js';

/** Far apart in hue and in lightness, so the series stay distinct in greyscale. */
const SERIES = ['#4C7DF0', '#3FB984', '#E8A33D', '#C86FD9', '#E4695E', '#4FBBD1', '#9AA43C', '#E07EA8'];

const W = 640;
const H = 360;
const PAD = { top: 34, right: 18, bottom: 46, left: 52 };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Round a maximum up to something a person would choose for an axis. */
function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Trim a number for display without turning 11.7 into 12. */
const fmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US');
  return String(Math.round(n * 100) / 100);
};

/**
 * Parse a chart spec. Returns null for anything that is not one, which is how
 * a half-streamed block and a model's malformed JSON both end up rendered as
 * ordinary code instead of a broken picture.
 */
export function parseChart(source) {
  let spec;
  try {
    spec = JSON.parse(String(source));
  } catch {
    return null;
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;

  const rows = Array.isArray(spec.data) ? spec.data : [];
  const data = rows
    .map((row, i) =>
      row && typeof row === 'object'
        ? { label: String(row.label ?? row.name ?? i + 1), value: num(row.value ?? row.y ?? row.count) }
        : { label: String(i + 1), value: num(row) }
    )
    .slice(0, 60); // a chat bubble is not a dashboard

  if (!data.length) return null;

  const type = ['bar', 'line', 'area', 'pie', 'donut'].includes(spec.type) ? spec.type : 'bar';
  return {
    type,
    title: spec.title ? String(spec.title) : '',
    unit: spec.unit ? String(spec.unit) : '',
    xLabel: spec.xLabel ? String(spec.xLabel) : '',
    yLabel: spec.yLabel ? String(spec.yLabel) : '',
    data,
  };
}

const axis = (spec, max) => {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const plotH = H - PAD.top - PAD.bottom;
  return ticks
    .map((value) => {
      const y = PAD.top + plotH - (value / max) * plotH;
      return (
        `<line class="c-grid" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" />` +
        `<text class="c-tick" x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(fmt(value))}</text>`
      );
    })
    .join('');
};

/** Labels along the bottom, thinned out when there are more than will fit. */
function xLabels(data) {
  const plotW = W - PAD.left - PAD.right;
  const step = plotW / data.length;
  const every = Math.ceil((data.length * 58) / plotW);
  return data
    .map((d, i) => {
      if (i % every !== 0) return '';
      const x = PAD.left + step * (i + 0.5);
      return `<text class="c-label" x="${x.toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle">${escapeHtml(
        d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label
      )}</text>`;
    })
    .join('');
}

function bars(spec) {
  const max = niceMax(Math.max(...spec.data.map((d) => d.value), 0));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / spec.data.length;
  const width = Math.max(4, Math.min(48, step * 0.62));

  const rects = spec.data
    .map((d, i) => {
      const height = Math.max(0, (d.value / max) * plotH);
      const x = PAD.left + step * (i + 0.5) - width / 2;
      const y = PAD.top + plotH - height;
      return (
        `<g class="c-item"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" ` +
        `height="${height.toFixed(1)}" rx="3" fill="${SERIES[i % SERIES.length]}">` +
        `<title>${escapeHtml(`${d.label}: ${fmt(d.value)}${spec.unit ? ` ${spec.unit}` : ''}`)}</title></rect>` +
        `<text class="c-value" x="${(x + width / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${escapeHtml(
          fmt(d.value)
        )}</text></g>`
      );
    })
    .join('');

  return axis(spec, max) + rects + xLabels(spec.data);
}

function lines(spec, filled) {
  const max = niceMax(Math.max(...spec.data.map((d) => d.value), 0));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = spec.data.length > 1 ? plotW / (spec.data.length - 1) : 0;

  const points = spec.data.map((d, i) => {
    const x = PAD.left + (spec.data.length > 1 ? step * i : plotW / 2);
    const y = PAD.top + plotH - (d.value / max) * plotH;
    return { x, y, d };
  });

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = filled
    ? `<path d="${path} L${points.at(-1).x.toFixed(1)} ${PAD.top + plotH} L${points[0].x.toFixed(1)} ${
        PAD.top + plotH
      } Z" fill="${SERIES[0]}" opacity=".16" />`
    : '';

  const dots = points
    .map(
      (p) =>
        `<circle class="c-item" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${SERIES[0]}">` +
        `<title>${escapeHtml(`${p.d.label}: ${fmt(p.d.value)}${spec.unit ? ` ${spec.unit}` : ''}`)}</title></circle>`
    )
    .join('');

  return (
    axis(spec, max) +
    area +
    `<path d="${path}" fill="none" stroke="${SERIES[0]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />` +
    dots +
    xLabels(spec.data)
  );
}

function pie(spec, donut) {
  const total = spec.data.reduce((sum, d) => sum + Math.max(0, d.value), 0);
  if (total <= 0) return '';

  const cx = W / 2 - 70;
  const cy = H / 2 + 4;
  const r = Math.min(H - PAD.top - PAD.bottom, 220) / 2;
  let angle = -Math.PI / 2;

  const slices = spec.data
    .map((d, i) => {
      const share = Math.max(0, d.value) / total;
      const end = angle + share * Math.PI * 2;
      const large = share > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(end);
      const y2 = cy + r * Math.sin(end);
      // A single slice covering everything cannot be drawn as an arc: the start
      // and end points are the same, and the path collapses to nothing.
      const path =
        share >= 0.999
          ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SERIES[i % SERIES.length]}" />`
          : `<path d="M${cx} ${cy} L${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(
              1
            )} ${y2.toFixed(1)} Z" fill="${SERIES[i % SERIES.length]}" />`;
      angle = end;
      return (
        `<g class="c-item">${path}<title>${escapeHtml(
          `${d.label}: ${fmt(d.value)}${spec.unit ? ` ${spec.unit}` : ''} (${Math.round(share * 100)}%)`
        )}</title></g>`
      );
    })
    .join('');

  const hole = donut ? `<circle cx="${cx}" cy="${cy}" r="${(r * 0.58).toFixed(1)}" class="c-hole" />` : '';

  const legend = spec.data
    .map((d, i) => {
      const y = PAD.top + 10 + i * 22;
      const share = Math.round((Math.max(0, d.value) / total) * 100);
      return (
        `<rect x="${W - 178}" y="${y - 9}" width="10" height="10" rx="2" fill="${SERIES[i % SERIES.length]}" />` +
        `<text class="c-label" x="${W - 162}" y="${y}" text-anchor="start">${escapeHtml(
          d.label.length > 16 ? `${d.label.slice(0, 15)}…` : d.label
        )} · ${share}%</text>`
      );
    })
    .join('');

  return slices + hole + legend;
}

/**
 * Render a parsed spec to SVG.
 *
 * @param {object} spec  from parseChart
 * @returns {string} an <svg> element, self-contained apart from its CSS classes
 */
export function renderChart(spec) {
  if (!spec) return '';

  const body =
    spec.type === 'pie' || spec.type === 'donut'
      ? pie(spec, spec.type === 'donut')
      : spec.type === 'line'
        ? lines(spec, false)
        : spec.type === 'area'
          ? lines(spec, true)
          : bars(spec);

  const title = spec.title
    ? `<text class="c-title" x="${PAD.left}" y="20" text-anchor="start">${escapeHtml(spec.title)}</text>`
    : '';
  const yLabel = spec.yLabel
    ? `<text class="c-axis" transform="translate(14 ${H / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(
        spec.yLabel
      )}</text>`
    : '';
  const xLabel = spec.xLabel
    ? `<text class="c-axis" x="${W / 2}" y="${H - 6}" text-anchor="middle">${escapeHtml(spec.xLabel)}</text>`
    : '';

  return (
    `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" ` +
    `aria-label="${escapeHtml(spec.title || `${spec.type} chart`)}" xmlns="http://www.w3.org/2000/svg">` +
    `${title}${yLabel}${xLabel}${body}</svg>`
  );
}

/** One call for the renderer: source text in, SVG out, or null if it is not a chart. */
export function chartFromSource(source) {
  const spec = parseChart(source);
  return spec ? { spec, svg: renderChart(spec) } : null;
}
