/* Formatting helpers shared by every panel. */

const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function num(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return numberFmt.format(Math.round(Number(value)));
}

export function compact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return Math.abs(n) >= 10000 ? compactFmt.format(n) : numberFmt.format(Math.round(n));
}

/**
 * Axis-tick variant: switches to compact notation from 1,000 up so a single
 * axis never mixes "15K" with "5,000".
 */
export function axisNum(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  return Math.abs(n) >= 1000 ? compactFmt.format(n) : numberFmt.format(Math.round(n));
}

export function percent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function decimal(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

/** Seconds -> "2m 14s" / "58s" / "1h 04m". */
export function duration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return '0s';
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/** "2026-09-04" -> "Sep 4" (dates are treated as UTC to avoid TZ drift). */
export function shortDate(iso) {
  if (!iso) return '';
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function longDate(iso) {
  if (!iso) return '';
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function dateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Percentage change against the comparison period.
 * `inverse` flips the colour logic for metrics where lower is better
 * (Search Console average position, for instance).
 */
export function delta(current, previous, { inverse = false } = {}) {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  if (!before) return { change: null, direction: 'flat', label: 'no prior data' };

  const change = (now - before) / Math.abs(before);
  const improving = inverse ? change < 0 : change > 0;
  const flat = Math.abs(change) < 0.0005;

  return {
    change,
    direction: flat ? 'flat' : improving ? 'up' : 'down',
    label: flat
      ? 'No change'
      : `${change >= 0 ? '+' : '−'}${(Math.abs(change) * 100).toFixed(1)}%`,
  };
}

/**
 * Delta for rank-style metrics, where a percentage is meaningless — moving
 * from position 1 to 2 is not "+100%". Reports the move in whole positions,
 * and treats a smaller number as the improvement.
 */
export function positionDelta(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before) || !before) {
    return { change: null, direction: 'flat', label: 'no prior data' };
  }

  const moved = before - now;
  const places = Math.abs(moved);
  if (places < 0.05) return { change: 0, direction: 'flat', label: 'No change' };

  return {
    change: moved,
    direction: moved > 0 ? 'up' : 'down',
    label: `${places % 1 === 0 ? places : places.toFixed(1)} ${
      places === 1 ? 'place' : 'places'
    }`,
  };
}

/** Truncates long URLs/paths for table cells while keeping the meaningful end. */
export function tidyPath(value, max = 46) {
  if (!value) return '/';
  let path = String(value);
  try {
    if (path.startsWith('http')) path = new URL(path).pathname || '/';
  } catch {
    /* keep the raw string if it will not parse */
  }
  if (path.length <= max) return path;
  return `${path.slice(0, max - 12)}…${path.slice(-10)}`;
}

/** Country codes come back from Search Console as ISO-3 (e.g. "usa"). */
const COUNTRY_NAMES = {
  usa: 'United States', can: 'Canada', gbr: 'United Kingdom', aus: 'Australia',
  ind: 'India', deu: 'Germany', fra: 'France', esp: 'Spain', ita: 'Italy',
  nld: 'Netherlands', mex: 'Mexico', bra: 'Brazil', phl: 'Philippines',
  pak: 'Pakistan', zaf: 'South Africa', irl: 'Ireland', nzl: 'New Zealand',
  sgp: 'Singapore', are: 'United Arab Emirates', jpn: 'Japan', chn: 'China',
};

export function countryName(code) {
  if (!code) return 'Unknown';
  const key = String(code).toLowerCase();
  return COUNTRY_NAMES[key] || (key.length === 3 ? key.toUpperCase() : code);
}

export function titleCase(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Builds a CSV from array-of-objects and triggers a browser download. */
export function downloadCsv(filename, rows, columns) {
  if (!rows?.length) return;
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = columns.map((column) => escape(column.label)).join(',');
  const body = rows
    .map((row) => columns.map((column) => escape(row[column.key])).join(','))
    .join('\n');

  const blob = new Blob([`${header}\n${body}`], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
