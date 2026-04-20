// ─── Kusto Workbench fixture constants ────────────────────────────────────────
//
// These strings represent what CDP methods would return from a running
// Kusto Workbench webview.  They are derived from:
//
//   - src/webview/queryEditor.html       → WEBVIEW_BODY_TEXT
//   - kw-data-table.ts  render()         → DATA_TABLE_* constants
//   - kw-sql-connection-form.ts render() → SQL_FORM_*
//   - kw-section-shell.ts render()       → SECTION_SHELL_*
//
// All values model innerText (plain text, no HTML tags) exactly as CDP's
// Runtime.evaluate('document.body.innerText') would return.
//
// Source: github.com/AngelosP/vscode-kusto-workbench  (no runtime dependency)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Body innerText of a Kusto Workbench webview (queryEditor.html).
 * Includes the "Add" toolbar buttons, section dropdown, and feedback link.
 * Hidden modals (object viewer, cell viewer, share) are collapsed to empty.
 */
export const WEBVIEW_BODY_TEXT = [
  'Add',
  'Kusto',
  'SQL',
  'Chart',
  'Transformation',
  'Python',
  'URL',
  'HTML',
  'Markdown',
  'Section',
  'Kusto\nSQL\nChart\nTransformation\nPython\nURL\nHTML\nMarkdown',
  'Ask for a fix or feature',
].join('\n');

/**
 * Toolbar innerText of a kw-data-table showing 3 rows from a StormEvents query.
 * Rendered by _renderHeader() inside the .hbar div.
 */
export const DATA_TABLE_TOOLBAR_TEXT =
  'StormEvents: 3 rows / 4 cols (12ms)';

/**
 * Full body innerText of a kw-data-table with 3 rows of Kusto StormEvents data.
 * Includes: toolbar, column headers, row numbers, cell values.
 * Columns: StartTime, EventType, DamageProperty, State
 */
export const DATA_TABLE_BODY_TEXT = [
  DATA_TABLE_TOOLBAR_TEXT,
  '#\tStartTime\tEventType\tDamageProperty\tState',
  '1\t2007-01-01T00:00:00Z\tFlood\t10000\tFLORIDA',
  '2\t2007-01-01T06:00:00Z\tThunderstorm Wind\t0\tGEORGIA',
  '3\t2007-01-01T08:00:00Z\tWinter Storm\tnull\tNEW YORK',
].join('\n');

/**
 * Body innerText of a kw-data-table with zero filtered rows.
 * The .empty-body div contains this text.
 */
export const DATA_TABLE_EMPTY_TEXT = 'No matching rows';

/**
 * Body innerText of a kw-data-table with columns defined but no rows.
 * The .empty div contains this text when no data was returned.
 */
export const DATA_TABLE_NO_DATA_TEXT = 'No data';

/**
 * innerText of a kw-sql-connection-form with default values.
 * Form fields: Connection Name, Server URL, Port, Dialect, Authentication,
 * Default Database, and a "Test Connection" button.
 */
export const SQL_FORM_BODY_TEXT = [
  'Connection Name',
  'Server URL *',
  'Port',
  '1433',
  'Dialect',
  'SQL Server',
  'Authentication',
  'AAD (Default)',
  'Default Database',
  'Test Connection',
].join('\n');

/**
 * innerText of a kw-section-shell header for a Kusto query section.
 * Includes drag handle glyph, section name, and action buttons.
 */
export const SECTION_SHELL_HEADER_TEXT = '⋮ Query 1\nHide\nRemove';

/**
 * innerText of a kw-section-shell header with modification indicator.
 */
export const SECTION_SHELL_MODIFIED_HEADER_TEXT = '⋮ Query 1\n(modified)\nHide\nRemove';

/**
 * Extension output channel content after a successful activation.
 * Simulates what the "Kusto Workbench" output channel would contain.
 */
export const OUTPUT_CHANNEL_ACTIVATION = [
  '[2026-04-19 10:00:01] Kusto Workbench activating...',
  '[2026-04-19 10:00:01] ConnectionManager initialized (0 connections)',
  '[2026-04-19 10:00:01] KQL language service ready',
  '[2026-04-19 10:00:02] Extension activated successfully',
].join('\n');

/**
 * Selectors used in real Kusto Workbench E2E tests.
 * These match the CSS selectors and data attributes actually present in the DOM.
 */
export const SELECTORS = {
  // queryEditor.html elements
  queriesContainer: '#queries-container',
  addKustoBtn: "[data-add-kind='query']",
  addSqlBtn: "[data-add-kind='sql']",
  objectViewer: '#objectViewer',
  shareModal: '#shareModal',

  // kw-data-table elements
  tableHead: '#dt-head',
  tableBody: '#dt-body',
  firstRow: "tr[data-idx='0']",
  secondRow: "tr[data-idx='1']",
  emptyBody: '.empty-body',
  noData: '.empty',
  toolbar: '.hbar',
  toolbarButton: '.tbtn',
  selectedRow: '.sel-row',
  nullCell: '.null-cell',
  objectCell: '.obj-cell',

  // kw-sql-connection-form elements (data-testid)
  // Single-quoted attribute values so selectors can be embedded in
  // Gherkin step text which uses double-quote delimiters.
  sqlConnName: "[data-testid='sql-conn-name']",
  sqlConnServer: "[data-testid='sql-conn-server']",
  sqlConnPort: "[data-testid='sql-conn-port']",
  sqlConnAuth: "[data-testid='sql-conn-auth']",
  sqlConnDatabase: "[data-testid='sql-conn-database']",

  // kw-section-shell elements
  sectionHeader: '.section-header',
  sectionDragHandle: '.section-drag-handle',
  sectionName: '.query-name',
  toggleBtn: '.toggle-btn',
  closeBtn: '.close-btn',

  // E2E data-test attributes used in real tests
  sqlConnection: '[data-test-sql-connection]',
  schemaReady: '[data-test-schema-ready]',
  databaseSelected: '[data-test-database-selected]',
  suggestWidget: '.suggest-widget.visible',
} as const;
