/*
 * Chart.js configuration for the dashboard.
 *
 * Palette: the brand orange leads, then five hues validated for colour-vision
 * deficiency separation (worst adjacent pair ΔE 16.8 deutan / 19.3 normal) and
 * for >= 3:1 contrast against the card surface. Hues are assigned in fixed order
 * and never cycled — a seventh series folds into "Other" upstream.
 *
 * No chart here uses two y-axes. Where two measures have different magnitudes
 * (Search Console clicks vs impressions) they are drawn as separate charts.
 */

export const PALETTE = [
  '#fb4513', // brand orange
  '#1c7fd6', // blue
  '#0e8f5a', // green
  '#9b51e0', // purple
  '#b0006e', // magenta
  '#a87400', // gold
];

const INK = '#1f2124';
const INK_MUTED = '#6b7075';
const GRID = '#e9ecef';
const SURFACE = '#ffffff';

const FONT_FAMILY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Live chart instances, keyed by canvas id, so a redraw replaces cleanly. */
const registry = new Map();

export function destroyChart(canvasId) {
  const existing = registry.get(canvasId);
  if (existing) {
    existing.destroy();
    registry.delete(canvasId);
  }
}

export function destroyAll() {
  for (const chart of registry.values()) chart.destroy();
  registry.clear();
}

function mount(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof window.Chart === 'undefined') return null;

  destroyChart(canvasId);
  const chart = new window.Chart(canvas.getContext('2d'), config);
  registry.set(canvasId, chart);
  return chart;
}

/** Recessive axes and a tooltip that reads as one card, shared by all charts. */
function baseOptions({ valueFormatter, showLegend, beginAtZero = true, reverse = false }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 4 } },
    plugins: {
      legend: {
        display: showLegend,
        position: 'top',
        align: 'end',
        labels: {
          usePointStyle: true,
          pointStyle: 'circle',
          boxWidth: 7,
          boxHeight: 7,
          padding: 14,
          color: INK_MUTED,
          font: { family: FONT_FAMILY, size: 11.5, weight: '600' },
        },
      },
      tooltip: {
        backgroundColor: '#26282b',
        titleColor: '#fff',
        bodyColor: '#e8eaec',
        padding: 11,
        cornerRadius: 6,
        displayColors: true,
        usePointStyle: true,
        boxWidth: 7,
        boxHeight: 7,
        boxPadding: 5,
        titleFont: { family: FONT_FAMILY, size: 12, weight: '700' },
        bodyFont: { family: FONT_FAMILY, size: 12 },
        callbacks: {
          label: (context) => {
            const value = context.parsed.y ?? context.parsed;
            return ` ${context.dataset.label}: ${
              valueFormatter ? valueFormatter(value) : value
            }`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: GRID },
        ticks: {
          color: INK_MUTED,
          font: { family: FONT_FAMILY, size: 11 },
          maxRotation: 0,
          autoSkipPadding: 18,
        },
      },
      y: {
        // Counts start at zero; rates and rankings would flatline if they did.
        beginAtZero,
        // Search Console position is better when lower, so that axis runs
        // downward — a rising line always means improving.
        reverse,
        border: { display: false },
        grid: { color: GRID, drawTicks: false },
        ticks: {
          color: INK_MUTED,
          font: { family: FONT_FAMILY, size: 11 },
          padding: 8,
          maxTicksLimit: 6,
          callback: (value) =>
            valueFormatter ? valueFormatter(value, true) : value,
        },
      },
    },
  };
}

/** Vertical gradient under an area line, fading to transparent. */
function areaFill(context, hex) {
  const { ctx, chartArea } = context.chart;
  if (!chartArea) return 'transparent';
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, `${hex}2e`);
  gradient.addColorStop(1, `${hex}00`);
  return gradient;
}

/**
 * Time-series line chart.
 * @param {object[]} series [{ label, data, color?, dashed? }]
 */
export function lineChart(
  canvasId,
  labels,
  series,
  { valueFormatter, beginAtZero = true, reverse = false } = {}
) {
  return mount(canvasId, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((entry, i) => {
        const color = entry.color || PALETTE[i % PALETTE.length];
        // On a reversed axis the fill would run upward from the top edge, so
        // the rank chart is drawn as a bare line.
        const filled = series.length === 1 && !entry.dashed && !reverse;
        return {
          label: entry.label,
          data: entry.data,
          borderColor: color,
          backgroundColor: filled ? (context) => areaFill(context, color) : 'transparent',
          fill: filled,
          borderWidth: 2,
          borderDash: entry.dashed ? [5, 4] : undefined,
          tension: 0.32,
          pointRadius: 0,
          // Markers only appear on hover, and are comfortably clickable.
          pointHoverRadius: 5,
          pointHoverBorderWidth: 2.5,
          pointHoverBorderColor: SURFACE,
          pointHoverBackgroundColor: color,
        };
      }),
    },
    options: {
      ...baseOptions({
        valueFormatter,
        showLegend: series.length > 1,
        beginAtZero,
        reverse,
      }),
    },
  });
}

/** Horizontal bars — the right form for ranked categories with long labels. */
export function barChart(canvasId, labels, values, { valueFormatter, color } = {}) {
  const options = baseOptions({ valueFormatter, showLegend: false });

  return mount(canvasId, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Sessions',
          data: values,
          backgroundColor: color || PALETTE[0],
          hoverBackgroundColor: color || PALETTE[0],
          // Rounded data-end only; the baseline end stays square.
          borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
          borderSkipped: false,
          barPercentage: 0.72,
          categoryPercentage: 0.82,
        },
      ],
    },
    options: {
      ...options,
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      scales: {
        x: {
          // Bars run horizontally, so the measure axis is x and the category
          // axis is y — the base scale definitions swap over.
          ...options.scales.y,
          grid: { color: GRID, drawTicks: false },
        },
        y: {
          ...options.scales.x,
          ticks: { ...options.scales.x.ticks, autoSkip: false },
        },
      },
    },
  });
}

/** Donut for a small part-to-whole split (device category). */
export function donutChart(canvasId, labels, values, { valueFormatter } = {}) {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;

  return mount(canvasId, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
          // A 2px surface ring separates adjacent segments.
          borderColor: SURFACE,
          borderWidth: 2,
          hoverOffset: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '64%',
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 7,
            boxHeight: 7,
            padding: 13,
            color: INK_MUTED,
            font: { family: FONT_FAMILY, size: 11.5, weight: '600' },
          },
        },
        tooltip: {
          backgroundColor: '#26282b',
          titleColor: '#fff',
          bodyColor: '#e8eaec',
          padding: 11,
          cornerRadius: 6,
          usePointStyle: true,
          boxWidth: 7,
          boxHeight: 7,
          boxPadding: 5,
          titleFont: { family: FONT_FAMILY, size: 12, weight: '700' },
          bodyFont: { family: FONT_FAMILY, size: 12 },
          callbacks: {
            label: (context) => {
              const value = context.parsed;
              const share = ((value / total) * 100).toFixed(1);
              return ` ${context.label}: ${
                valueFormatter ? valueFormatter(value) : value
              } (${share}%)`;
            },
          },
        },
      },
    },
  });
}

/** Applied once, before any chart is drawn. */
export function applyChartDefaults() {
  if (typeof window.Chart === 'undefined') return;
  window.Chart.defaults.font.family = FONT_FAMILY;
  window.Chart.defaults.font.size = 12;
  window.Chart.defaults.color = INK;
  window.Chart.defaults.animation.duration = 420;
}
