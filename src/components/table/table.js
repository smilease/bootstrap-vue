import startCase from 'lodash.startcase'
import get from 'lodash.get'
import looseEqual from '../../utils/loose-equal'
import stableSort from '../../utils/stable-sort'
import KeyCodes from '../../utils/key-codes'
import warn from '../../utils/warn'
import stripScripts from '../../utils/strip-scripts'
import { keys, assign } from '../../utils/object'
import { arrayIncludes, isArray } from '../../utils/array'
import idMixin from '../../mixins/id'
import listenOnRootMixin from '../../mixins/listen-on-root'

// Import styles for busy and stacked
import './table.css'

// Object of item keys that should be ignored for headers and stringification and filter events
const IGNORED_FIELD_KEYS = {
  _rowVariant: true,
  _cellVariants: true,
  _showDetails: true
}

// Return a copy of a row after all reserved fields have been filtered out
function sanitizeRow (row) {
  return keys(row).reduce((obj, key) => {
    // Ignore special fields that start with _
    if (!IGNORED_FIELD_KEYS[key]) {
      obj[key] = row[key]
    }
    return obj
  }, {})
}

// Stringifies the values of an object
//   { b: 3, c: { z: 'zzz', d: null, e: 2 }, d: [10, 12, 11], a: 'one' }
// becomes
//   'one 3 2 zzz 10 12 11'
function toString (v) {
  if (!v) {
    return ''
  }
  if (v instanceof Object) {
    // Arrays are also object, and keys just returns the array
    return keys(v)
      .sort() /* sort to prevent SSR issues on pre-rendered sorted tables */
      .map(k => toString(v[k]))
      .join(' ')
  }
  return String(v)
}

// Stringifies the values of a record, ignoring any special top level keys
function recToString (row) {
  if (!(row instanceof Object)) {
    return ''
  }
  return toString(sanitizeRow(row))
}

function defaultSortCompare (a, b, sortBy) {
  if (sortBy.indexOf('.') < 0) {
    return sort(a[sortBy], b[sortBy])
  } else {
    return sort(getNestedValue(a, sortBy), getNestedValue(b, sortBy))
  }
}

function sort (a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return (a < b && -1) || (a > b && 1) || 0
  }
  return toString(a).localeCompare(toString(b), undefined, {
    numeric: true
  })
}

function getNestedValue (obj, path) {
  path = path.split('.')
  var value = obj
  for (var i = 0; i < path.length; i++) {
    value = value[path[i]]
  }
  return value
}

function processField (key, value) {
  let field = null
  if (typeof value === 'string') {
    // Label shortcut
    field = { key, label: value }
  } else if (typeof value === 'function') {
    // Formatter shortcut
    field = { key, formatter: value }
  } else if (typeof value === 'object') {
    field = assign({}, value)
    field.key = field.key || key
  } else if (value !== false) {
    // Fallback to just key
    field = { key }
  }
  return field
}

// Determine if two given arrays are *not* loosely equal
function arraysNotEqual (left = [], right = []) {
  if (left === right) {
    // If left reference is equal to the right reference, then they are equal
    return false
  } else if (left.length === 0 && right.length === 0) {
    // If they are both zero length then they are equal
    return true
  } else if (left.length !== right.length) {
    // If they have different lengths then they are definitely not equal
    return true
  } else {
    const equal = left.every((item, index) => {
      // We compare left array, row by row, until we find a row that is not equal in the same
      // row index in the right array.
      // Note: This process can be slow for rather large datasets!
      return looseEqual(sanitizeRow(item), sanitizeRow(right[index]))
    })
    return !equal
  }
}

export default {
  mixins: [idMixin, listenOnRootMixin],
  render (h) {
    const $slots = this.$slots
    const $scoped = this.$scopedSlots
    const fields = this.computedFields
    const items = this.computedItems

    // Build the caption
    let caption = h(false)
    if (this.caption || $slots['table-caption']) {
      const data = { style: this.captionStyles }
      if (!$slots['table-caption']) {
        data.domProps = { innerHTML: stripScripts(this.caption) }
      }
      caption = h('caption', data, $slots['table-caption'])
    }

    // Build the colgroup
    const colgroup = $slots['table-colgroup']
      ? h('colgroup', {}, $slots['table-colgroup'])
      : h(false)

    // factory function for thead and tfoot cells (th's)
    const makeHeadCells = (isFoot = false) => {
      return fields.map((field, colIndex) => {
        const data = {
          key: field.key,
          class: this.fieldClasses(field),
          style: field.thStyle || {},
          attrs: {
            tabindex: field.sortable ? '0' : null,
            abbr: field.headerAbbr || null,
            title: field.headerTitle || null,
            'aria-colindex': String(colIndex + 1),
            'aria-label': field.sortable
              ? this.localSortDesc && this.localSortBy === field.key
                ? this.labelSortAsc
                : this.labelSortDesc
              : null,
            'aria-sort':
              field.sortable && this.localSortBy === field.key
                ? this.localSortDesc ? 'descending' : 'ascending'
                : null
          },
          on: {
            click: evt => {
              evt.stopPropagation()
              evt.preventDefault()
              this.headClicked(evt, field)
            },
            keydown: evt => {
              const keyCode = evt.keyCode
              if (keyCode === KeyCodes.ENTER || keyCode === KeyCodes.SPACE) {
                evt.stopPropagation()
                evt.preventDefault()
                this.headClicked(evt, field)
              }
            }
          }
        }
        let slot =
          isFoot && $scoped[`FOOT_${field.key}`]
            ? $scoped[`FOOT_${field.key}`]
            : $scoped[`HEAD_${field.key}`]
        if (slot) {
          slot = [slot({ label: field.label, column: field.key, field: field })]
        } else {
          data.domProps = { innerHTML: stripScripts(field.label) }
        }
        return h('th', data, slot)
      })
    }

    // Build the thead
    let thead = h(false)
    if (this.isStacked !== true) {
      // If in always stacked mode (this.isStacked === true), then we don't bother rendering the thead
      thead = h('thead', { class: this.headClasses }, [
        h('tr', { class: this.theadTrClass }, makeHeadCells(false))
      ])
    }

    // Build the tfoot
    let tfoot = h(false)
    if (this.footClone && this.isStacked !== true) {
      // If in always stacked mode (this.isStacked === true), then we don't bother rendering the tfoot
      tfoot = h('tfoot', { class: this.footClasses }, [
        h('tr', { class: this.tfootTrClass }, makeHeadCells(true))
      ])
    }

    // Prepare the tbody rows
    const rows = []

    // Add static Top Row slot (hidden in visibly stacked mode as we can't control the data-label)
    // If in always stacked mode, we don't bother rendering the row
    if ($scoped['top-row'] && this.isStacked !== true) {
      rows.push(
        h(
          'tr',
          { key: 'top-row', class: ['b-table-top-row', typeof this.tbodyTrClass === 'function' ? this.tbodyTrClass(null, 'row-top') : this.tbodyTrClass] },
          [$scoped['top-row']({ columns: fields.length, fields: fields })]
        )
      )
    } else {
      rows.push(h(false))
    }

    // Add the item data rows
    items.forEach((item, rowIndex) => {
      const detailsSlot = $scoped['row-details']
      const rowShowDetails = Boolean(item._showDetails && detailsSlot)
      const detailsId = rowShowDetails
        ? this.safeId(`_details_${rowIndex}_`)
        : null
      const toggleDetailsFn = () => {
        if (detailsSlot) {
          this.$set(item, '_showDetails', !item._showDetails)
        }
      }
      // For each item data field in row
      const tds = fields.map((field, colIndex) => {
        const data = {
          key: `row-${rowIndex}-cell-${colIndex}`,
          class: this.tdClasses(field, item),
          attrs: this.tdAttrs(field, item, colIndex),
          domProps: {}
        }
        let childNodes
        if ($scoped[field.key]) {
          childNodes = [
            $scoped[field.key]({
              item: item,
              index: rowIndex,
              field: field,
              unformatted: get(item, field.key),
              value: this.getFormattedValue(item, field),
              toggleDetails: toggleDetailsFn,
              detailsShowing: Boolean(item._showDetails)
            })
          ]
          if (this.isStacked) {
            // We wrap in a DIV to ensure rendered as a single cell when visually stacked!
            childNodes = [h('div', {}, [childNodes])]
          }
        } else {
          const formatted = this.getFormattedValue(item, field)
          if (this.isStacked) {
            // We wrap in a DIV to ensure rendered as a single cell when visually stacked!
            childNodes = [h('div', formatted)]
          } else {
            // Non stacked
            childNodes = formatted
          }
        }
        // Render either a td or th cell
        return h(field.isRowHeader ? 'th' : 'td', data, childNodes)
      })
      // Calculate the row number in the dataset (indexed from 1)
      let ariaRowIndex = null
      if (this.currentPage && this.perPage && this.perPage > 0) {
        ariaRowIndex = (this.currentPage - 1) * this.perPage + rowIndex + 1
      }
      // Assemble and add the row
      rows.push(
        h(
          'tr',
          {
            key: `row-${rowIndex}`,
            class: [
              this.rowClasses(item),
              { 'b-table-has-details': rowShowDetails }
            ],
            attrs: {
              'aria-describedby': detailsId,
              'aria-rowindex': ariaRowIndex,
              role: this.isStacked ? 'row' : null
            },
            on: {
              click: evt => {
                this.rowClicked(evt, item, rowIndex)
              },
              contextmenu: evt => {
                this.rowContextmenu(evt, item, rowIndex)
              },
              dblclick: evt => {
                this.rowDblClicked(evt, item, rowIndex)
              },
              mouseenter: evt => {
                this.rowHovered(evt, item, rowIndex)
              },
              mouseleave: evt => {
                this.rowUnhovered(evt, item, rowIndex)
              }
            }
          },
          tds
        )
      )
      // Row Details slot
      if (rowShowDetails) {
        const tdAttrs = { colspan: String(fields.length) }
        const trAttrs = { id: detailsId }
        if (this.isStacked) {
          tdAttrs['role'] = 'cell'
          trAttrs['role'] = 'row'
        }
        const details = h('td', { attrs: tdAttrs }, [
          detailsSlot({
            item: item,
            index: rowIndex,
            fields: fields,
            toggleDetails: toggleDetailsFn
          })
        ])
        rows.push(
          h(
            'tr',
            {
              key: `details-${rowIndex}`,
              class: ['b-table-details', typeof this.tbodyTrClass === 'function' ? this.tbodyTrClass(item, 'row-details') : this.tbodyTrClass],
              attrs: trAttrs
            },
            [details]
          )
        )
      } else if (detailsSlot) {
        // Only add the placeholder if a the table has a row-details slot defined (but not shown)
        rows.push(h(false))
      }
    })

    // Empty Items / Empty Filtered Row slot
    if (this.showEmpty && (!items || items.length === 0)) {
      let empty = this.isFiltered ? $slots['emptyfiltered'] : $slots['empty']
      if (!empty) {
        empty = h('div', {
          class: ['text-center', 'my-2'],
          domProps: { innerHTML: stripScripts(this.filter ? this.emptyFilteredText : this.emptyText) }
        })
      }
      empty = h(
        'td',
        {
          attrs: {
            colspan: String(fields.length),
            role: this.isStacked ? 'cell' : null
          }
        },
        [h('div', { attrs: { role: 'alert', 'aria-live': 'polite' } }, [empty])]
      )
      rows.push(
        h(
          'tr',
          {
            key: 'empty-row',
            class: ['b-table-empty-row', typeof this.tbodyTrClass === 'function' ? this.tbodyTrClass(null, 'row-empty') : this.tbodyTrClass],
            attrs: this.isStacked ? { role: 'row' } : {}
          },
          [empty]
        )
      )
    } else {
      rows.push(h(false))
    }

    // Static bottom row slot (hidden in visibly stacked mode as we can't control the data-label)
    // If in always stacked mode, we don't bother rendering the row
    if ($scoped['bottom-row'] && this.isStacked !== true) {
      rows.push(
        h(
          'tr',
          { key: 'bottom-row', class: ['b-table-bottom-row', typeof this.tbodyTrClass === 'function' ? this.tbodyTrClass(null, 'row-bottom') : this.tbodyTrClass] },
          [$scoped['bottom-row']({ columns: fields.length, fields: fields })]
        )
      )
    } else {
      rows.push(h(false))
    }

    // Assemble the rows into the tbody
    const tbody = h(
      'tbody',
      { class: this.bodyClasses, attrs: this.isStacked ? { role: 'rowgroup' } : {} },
      rows
    )

    // Assemble table
    const table = h(
      'table',
      {
        class: this.tableClasses,
        attrs: {
          id: this.safeId(),
          role: this.isStacked ? 'table' : null,
          'aria-busy': this.computedBusy ? 'true' : 'false',
          'aria-colcount': String(fields.length),
          'aria-rowcount': this.$attrs['aria-rowcount'] ||
            this.items.length > this.perPage ? this.items.length : null
        }
      },
      [caption, colgroup, thead, tfoot, tbody]
    )

    // Add responsive wrapper if needed and return table
    return this.isResponsive
      ? h('div', { class: this.responsiveClass }, [table])
      : table
  },
  props: {
    items: {
      type: [Array, Function],
      default () {
        return []
      }
    },
    fields: {
      type: [Object, Array],
      default: null
    },
    sortBy: {
      type: String,
      default: null
    },
    sortDesc: {
      type: Boolean,
      default: false
    },
    sortDirection: {
      type: String,
      default: 'asc',
      validator: direction => arrayIncludes(['asc', 'desc', 'last'], direction)
    },
    caption: {
      type: String,
      default: null
    },
    captionTop: {
      type: Boolean,
      default: false
    },
    striped: {
      type: Boolean,
      default: false
    },
    bordered: {
      type: Boolean,
      default: false
    },
    outlined: {
      type: Boolean,
      default: false
    },
    dark: {
      type: Boolean,
      default () {
        if (this && typeof this.inverse === 'boolean') {
          // Deprecate inverse
          warn(
            "b-table: prop 'inverse' has been deprecated. Use 'dark' instead"
          )
          return this.dark
        }
        return false
      }
    },
    inverse: {
      // Deprecated in v1.0.0 in favor of `dark`
      type: Boolean,
      default: null
    },
    hover: {
      type: Boolean,
      default: false
    },
    small: {
      type: Boolean,
      default: false
    },
    fixed: {
      type: Boolean,
      default: false
    },
    footClone: {
      type: Boolean,
      default: false
    },
    responsive: {
      type: [Boolean, String],
      default: false
    },
    stacked: {
      type: [Boolean, String],
      default: false
    },
    headVariant: {
      type: String,
      default: ''
    },
    footVariant: {
      type: String,
      default: ''
    },
    theadClass: {
      type: [String, Array],
      default: null
    },
    theadTrClass: {
      type: [String, Array],
      default: null
    },
    tbodyClass: {
      type: [String, Array],
      default: null
    },
    tbodyTrClass: {
      type: [String, Array, Function],
      default: null
    },
    tfootClass: {
      type: [String, Array],
      default: null
    },
    tfootTrClass: {
      type: [String, Array],
      default: null
    },
    perPage: {
      type: Number,
      default: 0
    },
    currentPage: {
      type: Number,
      default: 1
    },
    filter: {
      type: [String, RegExp, Function],
      default: null
    },
    sortCompare: {
      type: Function,
      default: null
    },
    noLocalSorting: {
      type: Boolean,
      default: false
    },
    noProviderPaging: {
      type: Boolean,
      default: false
    },
    noProviderSorting: {
      type: Boolean,
      default: false
    },
    noProviderFiltering: {
      type: Boolean,
      default: false
    },
    noSortReset: {
      type: Boolean,
      default: false
    },
    busy: {
      type: Boolean,
      default: false
    },
    value: {
      type: Array,
      default: () => []
    },
    labelSortAsc: {
      type: String,
      default: 'Click to sort Ascending'
    },
    labelSortDesc: {
      type: String,
      default: 'Click to sort Descending'
    },
    showEmpty: {
      type: Boolean,
      default: false
    },
    emptyText: {
      type: String,
      default: 'There are no records to show'
    },
    emptyFilteredText: {
      type: String,
      default: 'There are no records matching your request'
    },
    apiUrl: {
      // Passthrough prop. Passed to the context object. Not used by b-table directly
      type: String,
      default: ''
    }
  },
  data () {
    return {
      localSortBy: this.sortBy || '',
      localSortDesc: this.sortDesc || false,
      localBusy: false,
      localItems: isArray(this.items) ? this.items : [],
      filteredItems: isArray(this.items) ? this.items : [],
      isFiltered: false
    }
  },
  watch: {
    items (newItems = []) {
      if (this.hasProvider || newItems instanceof Function) {
        this.$nextTick(this._providerUpdate)
      } else if (isArray(newItems)) {
        // Set localItems/filteredItems to a copy of the provided array
        this.localItems = this.filteredItems = this.newItems.slice()
      } else {
        this.localItems = this.filteredItems = []
      }
    },
    filteredItems (newItems = [], oldItems = []) {
      // These comparisons can be computationally intensive on large datasets!
      if (arraysNotEqual(newItems, oldItems) || arraysNotEqual(newItems, this.localItems)) {
        this.isFiltered = true
        this.$emit('filtered', newItems, newItems.length)
      } else {
        if (this.isFiltered === true) {
          // We need to emit a filtered event if isFiltered transitions to false so that
          // users can update their pagination controls.
          this.$emit('filtered', newItems, newItems.length)
        }
        this.isFiltered = false
      }
    },
    context (newVal, oldVal) {
      if (!looseEqual(newVal, oldVal)) {
        this.$emit('context-changed', newVal)
      }
    },
    sortDesc (newVal, oldVal) {
      if (newVal === this.localSortDesc) {
        return
      }
      this.localSortDesc = newVal || false
    },
    localSortDesc (newVal, oldVal) {
      // Emit update to sort-desc.sync
      if (newVal !== oldVal) {
        this.$emit('update:sortDesc', newVal)
        if (!this.noProviderSorting) {
          this._providerUpdate()
        }
      }
    },
    sortBy (newVal, oldVal) {
      if (newVal === this.localSortBy) {
        return
      }
      this.localSortBy = newVal || null
    },
    localSortBy (newVal, oldVal) {
      if (newVal !== oldVal) {
        this.$emit('update:sortBy', newVal)
        if (!this.noProviderSorting) {
          this._providerUpdate()
        }
      }
    },
    perPage (newVal, oldVal) {
      if (oldVal !== newVal && !this.noProviderPaging) {
        this._providerUpdate()
      }
    },
    currentPage (newVal, oldVal) {
      if (oldVal !== newVal && !this.noProviderPaging) {
        this._providerUpdate()
      }
    },
    filter (newVal, oldVal) {
      if (oldVal !== newVal && !this.noProviderFiltering) {
        this._providerUpdate()
      }
    },
    localBusy (newVal, oldVal) {
      if (newVal !== oldVal) {
        this.$emit('update:busy', newVal)
      }
    }
  },
  mounted () {
    this.localSortBy = this.sortBy
    this.localSortDesc = this.sortDesc
    if (this.hasProvider) {
      // Fetch on mount
      this._providerUpdate()
    }
    // Listen for global messages to tell us to force refresh the table
    this.listenOnRoot('bv::refresh::table', id => {
      if (id === this.id || id === this) {
        this.refresh()
      }
    })
  },
  computed: {
    isStacked () {
      return this.stacked === '' ? true : this.stacked
    },
    isResponsive () {
      const responsive = this.responsive === '' ? true : this.responsive
      return this.isStacked ? false : responsive
    },
    responsiveClass () {
      return this.isResponsive === true
        ? 'table-responsive'
        : this.isResponsive ? `table-responsive-${this.responsive}` : ''
    },
    tableClasses () {
      return [
        'table',
        'b-table',
        this.striped ? 'table-striped' : '',
        this.hover ? 'table-hover' : '',
        this.dark ? 'table-dark' : '',
        this.bordered ? 'table-bordered' : '',
        this.small ? 'table-sm' : '',
        this.outlined ? 'border' : '',
        this.fixed ? 'b-table-fixed' : '',
        this.isStacked === true
          ? 'b-table-stacked'
          : this.isStacked ? `b-table-stacked-${this.stacked}` : ''
      ]
    },
    headClasses () {
      return [
        this.headVariant ? 'thead-' + this.headVariant : '',
        this.theadClass
      ]
    },
    bodyClasses () {
      return [this.tbodyClass]
    },
    footClasses () {
      const variant = this.footVariant || this.headVariant || null
      return [variant ? 'thead-' + variant : '', this.tfootClass]
    },
    captionStyles () {
      // Move caption to top
      return this.captionTop ? { captionSide: 'top' } : {}
    },
    hasProvider () {
      return this.items instanceof Function
    },
    localFiltering () {
      return this.hasProvider ? this.noProviderFiltering : true
    },
    localSorting () {
      return this.hasProvider ? this.noProviderSorting : !this.noLocalSorting
    },
    localPaging () {
      return this.hasProvider ? this.noProviderPaging : true
    },
    context () {
      return {
        perPage: this.perPage,
        currentPage: this.currentPage,
        filter: this.filter,
        sortBy: this.localSortBy,
        sortDesc: this.localSortDesc,
        apiUrl: this.apiUrl
      }
    },
    computedFields () {
      // We normalize fields into an array of objects
      // [ { key:..., label:..., ...}, {...}, ..., {..}]
      let fields = []
      if (isArray(this.fields)) {
        // Normalize array Form
        this.fields.filter(f => f).forEach(f => {
          if (typeof f === 'string') {
            fields.push({ key: f, label: startCase(f) })
          } else if (
            typeof f === 'object' &&
            f.key &&
            typeof f.key === 'string'
          ) {
            // Full object definition. We use assign so that we don't mutate the original
            fields.push(assign({}, f))
          } else if (typeof f === 'object' && keys(f).length === 1) {
            // Shortcut object (i.e. { 'foo_bar': 'This is Foo Bar' }
            const key = keys(f)[0]
            const field = processField(key, f[key])
            if (field) {
              fields.push(field)
            }
          }
        })
      } else if (
        this.fields &&
        typeof this.fields === 'object' &&
        keys(this.fields).length > 0
      ) {
        // Normalize object Form
        keys(this.fields).forEach(key => {
          let field = processField(key, this.fields[key])
          if (field) {
            fields.push(field)
          }
        })
      }
      // If no field provided, take a sample from first record (if exits)
      if (fields.length === 0 && this.computedItems.length > 0) {
        const sample = this.computedItems[0]
        keys(sample).forEach(k => {
          if (!IGNORED_FIELD_KEYS[k]) {
            fields.push({ key: k, label: startCase(k) })
          }
        })
      }
      // Ensure we have a unique array of fields and that they have String labels
      const memo = {}
      return fields.filter(f => {
        if (!memo[f.key]) {
          memo[f.key] = true
          f.label = typeof f.label === 'string' ? f.label : startCase(f.key)
          return true
        }
        return false
      })
    },
    computedItems () {
      let items = this.localItems || []
      // Grab some values to help trigger reactivity to prop changes, since
      // all of the grunt work is done via methods (which aren't reactive)
      const sortBy = this.localSortBy
      const sortDesc = this.localSortDesc
      const sortCompare = this.sortCompare
      const filter = this.computedFilter
      const currPage = this.currentPage
      const perPage = this.perPage
      // If table is busy, just return the current localItems
      if (this.computedBusy) {
        return items
      }
      // Apply (optional) local filter (returns a new array if filtering)
      if (filter) {
        // We also set this.filteredItems for triggering filtered events
        items = this.filteredItems = this.filterItems(items)
      }
      // Apply (optional) local sort (returns a new array if sorting)
      if (sortBy || typeof sortDesc === 'boolean' || sortCompare) {
        items = this.sortItems(items)
      }
      // Apply (optional) local pagination (returns new array if paginating)
      if (currPage || perPage) {
        items = this.paginateItems(items)
      }
      // Update the value model with the filtered/sorted/paginated data set.
      this.$emit('input', items)
      // send the (possibly) updated items to the table.
      return items
    },
    computedBusy () {
      return this.busy || this.localBusy
    },
    computedFilter () {
      if (this.filter instanceof Function) {
        // filter the items array using the function set in the filter prop
        // Wrap it in a function so we can prevent the filter function from mutating the top level data
        return (item) => {
          return this.filter(assign({}, item))
        }
      } else if (this.filter) {
        let regex = null
        if (this.filter instanceof RegExp) {
          regex = this.filter
        } else {
          // Escape special RegExp characters in the string
          const string = this.filter.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
          regex = new RegExp(`.*${string}.*`, 'ig')
        }
        // return a filter function
        return (item) => {
          const test = regex.test(recToString(item))
          regex.lastIndex = 0
          return test
        }
      } else {
        return null
      }
    }
  },
  methods: {
    keys,
    filterItems (items = []) {
      if (this.localFiltering && !!this.computedFilter && isArray(items) && items.length) {
        return items.filter(this.computedFilter) || []
      }
      return items
    },
    sortItems (items) {
      // Sorts the items and returns a new array of the sorted items
      const sortBy = this.localSortBy
      const sortDesc = this.localSortDesc
      const sortCompare = this.sortCompare
      const localSorting = this.localSorting
      if (sortBy && localSorting) {
        // stableSort returns a new arary, and leaves the original array intact
        return stableSort(items, (a, b) => {
          let result = null
          if (typeof sortCompare === 'function') {
            // Call user provided sortCompare routine
            result = sortCompare(a, b, sortBy, sortDesc)
          }
          if (result === null || result === undefined) {
            // Fallback to defaultSortCompare if sortCompare not defined or returns null
            result = defaultSortCompare(a, b, sortBy)
          }
          // Negate result if sorting in descending order
          return (result || 0) * (sortDesc ? -1 : 1)
        })
      }
      return items
    },
    paginateItems (items) {
      let currentPage = this.currentPage
      const perPage = this.perPage
      const localPaging = this.localPaging
      // Apply local pagination
      if (!!perPage && localPaging) {
        // Grab the current page of data (which may be past filtered items limit)
        return items.slice((currentPage - 1) * perPage, currentPage * perPage)
      }
      return items
    },
    fieldClasses (field) {
      return [
        field.sortable ? 'sorting' : '',
        field.sortable && this.localSortBy === field.key
          ? 'sorting_' + (this.localSortDesc ? 'desc' : 'asc')
          : '',
        field.variant ? 'table-' + field.variant : '',
        field.class ? field.class : '',
        field.thClass ? field.thClass : ''
      ]
    },
    tdClasses (field, item) {
      let cellVariant = ''
      if (item._cellVariants && item._cellVariants[field.key]) {
        cellVariant = `${this.dark ? 'bg' : 'table'}-${
          item._cellVariants[field.key]
        }`
      }
      return [
        field.variant && !cellVariant
          ? `${this.dark ? 'bg' : 'table'}-${field.variant}`
          : '',
        cellVariant,
        field.class ? field.class : '',
        this.getTdValues(item, field.key, field.tdClass, '')
      ]
    },
    tdAttrs (field, item, colIndex) {
      let attrs = {}
      attrs['aria-colindex'] = String(colIndex + 1)
      if (this.isStacked) {
        // Generate the "header cell" label content in stacked mode
        attrs['data-label'] = field.label
        if (field.isRowHeader) {
          attrs['role'] = 'rowheader'
        } else {
          attrs['role'] = 'cell'
        }
      }
      return assign({}, attrs, this.getTdValues(item, field.key, field.tdAttr, {}))
    },
    rowClasses (item) {
      return [
        item._rowVariant
          ? `${this.dark ? 'bg' : 'table'}-${item._rowVariant}`
          : '',
        typeof this.tbodyTrClass === 'function' ? this.tbodyTrClass(item, 'row') : this.tbodyTrClass
      ]
    },
    rowClicked (e, item, index) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      this.$emit('row-clicked', item, index, e)
    },
    rowDblClicked (e, item, index) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      this.$emit('row-dblclicked', item, index, e)
    },
    rowHovered (e, item, index) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      this.$emit('row-hovered', item, index, e)
    },
    rowUnhovered (e, item, index) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      this.$emit('row-unhovered', item, index, e)
    },
    rowContextmenu (e, item, index) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      this.$emit('row-contextmenu', item, index, e)
    },
    headClicked (e, field) {
      if (this.stopIfBusy(e)) {
        // If table is busy (via provider) then don't propagate
        return
      }
      let sortChanged = false
      const toggleLocalSortDesc = () => {
        const sortDirection = field.sortDirection || this.sortDirection
        if (sortDirection === 'asc') {
          this.localSortDesc = false
        } else if (sortDirection === 'desc') {
          this.localSortDesc = true
        }
      }
      if (field.sortable) {
        if (field.key === this.localSortBy) {
          // Change sorting direction on current column
          this.localSortDesc = !this.localSortDesc
        } else {
          // Start sorting this column ascending
          this.localSortBy = field.key
          toggleLocalSortDesc()
        }
        sortChanged = true
      } else if (this.localSortBy && !this.noSortReset) {
        this.localSortBy = null
        toggleLocalSortDesc()
        sortChanged = true
      }
      this.$emit('head-clicked', field.key, field, e)
      if (sortChanged) {
        // Sorting parameters changed
        this.$emit('sort-changed', this.context)
      }
    },
    stopIfBusy (evt) {
      if (this.computedBusy) {
        // If table is busy (via provider) then don't propagate
        evt.preventDefault()
        evt.stopPropagation()
        return true
      }
      return false
    },
    refresh () {
      // Expose refresh method
      if (this.hasProvider) {
        this.$nextTick(this._providerUpdate)
      } else {
        this.localItems = this.filteredItems = isArray(this.items) ? this.items.slice() : []
      }
    },
    _providerSetLocal (items) {
      this.localItems = this.filteredItems = isArray(items) ? items.slice() : []
      this.localBusy = false
      this.$emit('refreshed')
      // New root emit
      if (this.id) {
        this.emitOnRoot('bv::table::refreshed', this.id)
      }
    },
    _providerUpdate () {
      // Refresh the provider function items.
      // This method should be debounced with lodash.debounce to minimize network requests
      // with a 100ms default debounce period (i.e. 100ms wait after the last update before
      // the new update is called)
      if (this.computedBusy || !this.hasProvider) {
        // Don't refresh remote data if we are 'busy' or if no provider
        return
      }
      // Set internal busy state
      this.localBusy = true

      // Call provider function with context and optional callback after DOM is fully updated
      this.$nextTick(function () {
        const data = this.items(this.context, this._providerSetLocal)
        if (data && data.then && typeof data.then === 'function') {
          // Provider returned Promise
          data.then(items => {
            // Provider resolved with items
            this._providerSetLocal(items)
          })
        } else {
          // Provider returned Array data
          this._providerSetLocal(data)
        }
      })
    },
    getTdValues (item, key, tdValue, defValue) {
      const parent = this.$parent
      if (tdValue) {
        if (typeof tdValue === 'function') {
          let value = get(item, key)
          return tdValue(value, key, item)
        } else if (typeof tdValue === 'string' && typeof parent[tdValue] === 'function') {
          let value = get(item, key)
          return parent[tdValue](value, key, item)
        }
        return tdValue
      }
      return defValue
    },
    getFormattedValue (item, field) {
      const key = field.key
      const formatter = field.formatter
      const parent = this.$parent
      let value = get(item, key)
      if (formatter) {
        if (typeof formatter === 'function') {
          value = formatter(value, key, item)
        } else if (
          typeof formatter === 'string' &&
          typeof parent[formatter] === 'function'
        ) {
          value = parent[formatter](value, key, item)
        }
      }
      return (value === null || typeof value === 'undefined') ? '' : value
    }
  }
}
