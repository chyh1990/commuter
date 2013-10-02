// XXX Show test code for test cases.

// XXX Maybe provide control over what's displayed in a table detail?

// XXX Reduce initial database more, lazily load other data.

// XXX Sorting by test case number is currently lexicographic, but
// should be numeric.  Maybe we should also sort calls by CALL_SEQ.

// XXX In the table, just scan up to the limit to collect columns
// first and then scan again to build the table.

// Default order for calls
var CALL_SEQ = [
    'open', 'link', 'unlink', 'rename', 'stat',
    'fstat', 'lseek', 'close', 'pipe', 'read', 'write', 'pread', 'pwrite',
    'mmap', 'munmap', 'mprotect', 'memread', 'memwrite'];

//
// Mscan database
//

function databaseFromJSON(json) {
    // Reverse table-ification
    function untablify(table) {
        var fields = table['!fields'];
        var data = table['!data'];
        if (fields === undefined || data === undefined)
            return table;

        var out = [];
        var prev = {};
        var weight = [];
        for (var i = 0; i < data.length; i++) {
            var deltamask = data[i][0];

            // Get or compute weight of deltamask
            var dw = weight[deltamask];
            if (dw === undefined) {
                dw = 0;
                for (var j = 0; j < fields.length; j++)
                    if (deltamask & (1 << j))
                        ++dw;
                weight[deltamask] = dw;
            }

            // Get initial object
            var obj = data[i][dw + 1] || {};

            // Fill fields
            var deltapos = 1;
            for (var j = 0; j < fields.length; j++) {
                if (deltamask & (1 << j))
                    obj[fields[j]] = data[i][deltapos++];
                else
                    obj[fields[j]] = prev[fields[j]];
            }

            out.push(obj);
            prev = obj;
        }
        return out;
    }

    // Reverse deduplication of stacks
    var stackkeys = ['stack', 'stack1', 'stack2'];
    function getStacks(testcases, stacks) {
        if (stacks === undefined)
            return testcases;
        for (var tci = 0; tci < testcases.length; tci++) {
            var testcase = testcases[tci];
            for (var si = 0; si < testcase.shared.length; si++) {
                for (var ki = 0; ki < stackkeys.length; ki++) {
                    var k = stackkeys[ki];
                    var shared = testcase.shared[si];
                    if (shared[k] === undefined)
                        continue;
                    shared[k] = json.stacks[shared[k]];
                }
            }
        }
        return testcases;
    }

    // Put name components back together
    function rename(testcases) {
        for (var i = 0; i < testcases.length; i++) {
            var testcase = testcases[i];
            testcase.path = testcase.calls + '_' + testcase.pathid;
            testcase.test = testcase.path + '_' + testcase.testno;
            testcase.id = testcase.test + '_' + testcase.runid;
        }
        return testcases;
    }

    return rename(getStacks(untablify(json.testcases), json.stacks));
}

//
// Reactive rendezvous
//

function Rendezvous(value) {
    this.value = value;
    this.reactives = [];
}

Rendezvous.prototype.get = function(reactive) {
    if (reactive._re_version === undefined)
        reactive._re_version = 0;
    this.reactives.push({version:reactive._re_version, obj:reactive});
    return this.value;
};

Rendezvous.prototype.set = function(value) {
    if (value === this.value)
        return;
    this.value = value;
    var re = this.reactives;
    this.reactives = [];
    for (var i = 0; i < re.length; i++) {
        if (re[i].obj._re_version === re[i].version) {
            ++re[i].obj._re_version;
            re[i].obj.refresh();
        }
    }
};

//
// Query canvas
//

function QueryCanvas(parent) {
    this.inputRv = this.curRv = new Rendezvous(Enumerable.empty());
    this.container = $('<div>').appendTo(parent);
}

QueryCanvas.prototype.setInput = function(input) {
    this.inputRv.set(input);
};

QueryCanvas.prototype.heatmap = function(pred, facets) {
    var hm = new Heatmap(this.curRv, pred, facets);
    this.container.append(hm.elt.css('margin-bottom', '10px'));
    this.curRv = hm.outputRv;
    return this;
};

QueryCanvas.prototype.table = function() {
    var t = new Table(this.curRv);
    this.container.append(t.elt.css('margin-bottom', '10px'));
    this.curRv = t.outputRv;
    return this;
};

//
// Heatmap
//

function hsv2css(h, s, v) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return 'rgb(' + Math.floor(r * 255) + ',' + Math.floor(g * 255) + ',' +
        Math.floor(b * 255) + ')';
}

function inter(a, b, v) {
    return a * (1 - v) + b * v;
}

function Heatmap(inputRv, pred, facets) {
    this.inputRv = inputRv;
    this.pred = pred;
    this.facets = facets || function () { return ''; };
    this.color = function (frac) {
        if (frac == 0)
            return hsv2css(0.34065, 1, 0.91);
        return hsv2css(inter(0.34065, 0,   0.5 + frac / 2),
                       inter(1,       0.8, 0.5 + frac / 2),
                       inter(0.91,    1,   0.5 + frac / 2));
    };

    this.elt = $('<div>').css({textAlign: 'center'});
    this.selection = {};
    this.outputRv = new Rendezvous();
    this.refresh();
}

// Heatmap constants
Heatmap.FONT = '14px sans-serif';
Heatmap.CW = 16;
Heatmap.CH = 16;
Heatmap.PAD = Heatmap.CW / 2;

Heatmap.prototype.refresh = function() {
    var hmthis = this;
    this.elt.empty();
    var input = this.inputRv.get(this);

    // Get all calls, ordered by CALL_SEQ, then alphabetically.
    // XXX Maybe this shouldn't be symmetric.  For example, if my
    // input is for just one call set X_Y, then I shouldn't list both
    // X and Y on both the rows and columns.
    var calls = input.
        selectMany(function (testcase) { return testcase.calls.split('_'); }).
        distinct().
        orderBy(function (name) {
            var idx = CALL_SEQ.indexOf(name);
            if (idx >= 0)
                return '\x00' + String.fromCharCode(idx);
            return name;
        }).toArray();

    // Split input into facets
    var facets = 
        input.groupBy(this.facets, null, function (fLabel, testcases) {
            return {
                label: fLabel,
                // Split facet into cells
                cells: testcases.groupBy(
                    function (testcase) {  return testcase.calls; }, null,
                    function (tcCalls, testcases) {
                        // Compute cell location
                        var cellCalls = tcCalls.split('_');
                        var c1 = calls.indexOf(cellCalls[0]);
                        var c2 = calls.indexOf(cellCalls[1]);
                        if (c1 <= c2)
                            var x = calls.length - c2 - 1, y = c1;
                        else
                            var x = calls.length - c1 - 1, y = c2;

                        // Aggregate cell information
                        return testcases.aggregate(
                            {x:x, y:y, testcases:testcases,
                             total: 0, matched: 0},
                            function (sum, testcase) {
                                ++sum.total;
                                if (hmthis.pred(testcase))
                                    ++sum.matched;
                                return sum;
                            });
                    }).memoize()
            };
        }).memoize();

    // Create canvases and do initial renders
    this._maxLabel = 0;
    facets.forEach(function (facet) {
        var div = $('<div>').css({display: 'inline-block'}).
            appendTo(hmthis.elt);
        var canvas = $('<canvas>').appendTo(div);
        canvas.mousemove(function (ev) {
            var offset = canvas.offset();
            var x = ev.pageX - offset.left, y = ev.pageY - offset.top;
            hmthis._render(facet, hmthis._coordToCell(facet, x, y));
        });
        canvas.mouseout(function () {
            hmthis._render(facet, {});
        });
        canvas.click(function (ev) {
            // XXX Support selecting a whole call, too
            var offset = canvas.offset();
            var x = ev.pageX - offset.left, y = ev.pageY - offset.top;
            var oldFacet = hmthis.selection.facet;
            hmthis.selection = hmthis._coordToCell(facet, x, y);
            hmthis._render(facet, hmthis.selection);
            // Clear previous selection
            if (oldFacet && hmthis.selection.facet !== oldFacet)
                hmthis._render(oldFacet, {});

            // Update output
            if (!hmthis.selection.facet) {
                // Select everything by default
                hmthis.outputRv.set(input);
            } else {
                // XXX Only matched test cases, or all test cases for
                // this cell?  Since we don't display anything useful
                // for non-shared test cases right now, we only return
                // matched test cases.
                hmthis.outputRv.set(facet.cells.selectMany(function(cell) {
                    if (cell.x === hmthis.selection.x &&
                        cell.y === hmthis.selection.y)
                        return cell.testcases.where(hmthis.pred);
                    return [];
                }));
            }
        });

        var label = $('<div>').css({textAlign: 'center'}).text(facet.label).
            appendTo(div);

        facet.calls = calls;
        facet.canvas = canvas[0];
        facet.labelDiv = label;
        hmthis._render(facet, {});
    });

    // By default, pass all input through to output
    // XXX Keep selection over refresh
    this.outputRv.set(input);
};

Heatmap.prototype._coordToCell = function(facet, x, y) {
    var cx = Math.floor((x - facet.startX) / Heatmap.CW);
    var cy = Math.floor((y - facet.startY) / Heatmap.CH);
    if (cx < 0 || cy < 0 || cy > facet.calls.length - cx - 1)
        return {};
    return {facet:facet, x:cx, y:cy};
};

Heatmap.prototype._render = function(facet, hover) {
    // XXX Label with facet.label;
    var CW = Heatmap.CW, CH = Heatmap.CH, PAD = Heatmap.PAD;

    var hmthis = this;
    var calls = facet.calls;
    var ctx = facet.canvas.getContext('2d');

    // Measure labels
    if (this._maxLabel === 0) {
        ctx.font = Heatmap.FONT;
        for (var i = 0; i < calls.length; i++)
            this._maxLabel = Math.max(this._maxLabel,
                                      ctx.measureText(calls[i]).width);
    }
    var maxLabel = this._maxLabel;

    // Size (and clear) canvas
    var startX = maxLabel + PAD, startY = maxLabel + PAD;
    facet.startX = startX;
    facet.startY = startY;
    facet.canvas.width = startX + CW * calls.length + 5;
    facet.canvas.height = startY + CH * calls.length + 5;
    ctx.font = Heatmap.FONT;

    // Tweak facet label layout
    facet.labelDiv.css({paddingLeft: startX, width: CW * calls.length});

    // Labels
    ctx.save();
    ctx.textBaseline = 'middle'
    ctx.save();
    ctx.rotate(-Math.PI / 2);
    for (var i = 0; i < calls.length; i++) {
        if (i === hover.x)
            ctx.fillStyle = '#428bca';
        else
            ctx.fillStyle = 'black';
        ctx.fillText(calls[calls.length - i - 1],
                     -maxLabel, startX + i * CW + 0.5 * CW);
    }
    ctx.restore();
    ctx.textAlign = 'end';
    for (var i = 0; i < calls.length; i++) {
        if (i === hover.y)
            ctx.fillStyle = '#428bca';
        else
            ctx.fillStyle = 'black';
        ctx.fillText(calls[i], startX - PAD, startY + i * CH + 0.5 * CH);
    }
    ctx.restore();

    // Draw cells
    ctx.save();
    ctx.translate(startX, startY);

    // Gray "unknown" background
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (var i = 0; i < calls.length; i++) {
        ctx.lineTo(CW * (calls.length - i), i * CH);
        ctx.lineTo(CW * (calls.length - i), (i + 1) * CH);
    }
    ctx.lineTo(0, calls.length * CH);
    ctx.fillStyle = "#ccc";
    ctx.shadowOffsetX = ctx.shadowOffsetY = 3;
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(128,128,128,0.5)';
    ctx.fill();
    ctx.restore();

    // Known cells
    var clabels = [];
    facet.cells.forEach(function (cell) {
        ctx.fillStyle = hmthis.color(cell.matched / cell.total);
        ctx.fillRect(cell.x * CW, cell.y * CH, CW, CH);
        if (cell.matched > 0)
            clabels.push({x:cell.x, y:cell.y,
                          label:cell.matched.toString()});
    });

    // Hover
    if (hover.facet === facet) {
        ctx.save();
        ctx.strokeStyle = '#428bca';
        ctx.lineWidth = 2;
        ctx.strokeRect(hover.x * CW, hover.y * CH, CW, CH);
        ctx.restore();
    }

    // Selection
    if (this.selection.facet === facet) {
        ctx.save();
        ctx.strokeStyle = 'rgb(0,0,255)';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.selection.x * CW, this.selection.y * CH, CW, CH);
        ctx.restore();
    }

    // Cell labels
    // XXX Maybe this should only be shown on hover?  Could show
    // both total and matched.
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '7pt sans-serif';
    for (var i = 0; i < clabels.length; i++) {
        var cl = clabels[i];
        ctx.fillText(cl.label, (cl.x + 0.5) * CW, (cl.y + 0.5) * CH);
    }

    ctx.restore();

    // Mouse cursor
    $(facet.canvas).css({cursor: hover.facet === facet ? 'pointer' : 'auto'});
};


//
// Table UI
//

function Table(inputRv) {
    this.inputRv = inputRv;

    this.elt = $('<div>').addClass('datatable-wrapper');
    this.table = $('<table>').addClass('datatable').appendTo(this.elt);
    this.outputRv = new Rendezvous();
    this.refresh();
}

Table.INCREMENT = 100;
Table.COL_ORDER = ['calls', 'path', 'test', 'id', 'shared'];
Table.HIDE = ['runid', 'pathid', 'testno'];
Table.FORMATTERS = {
    shared: function(val) {
        if (!$.isArray(val))
            return;
        if (val.length === 0)
            return $('<td>0 addrs</td>');
        return $('<td style="color:#c00">').text(val.length + ' addrs');
    },
    path: function(val) {
        var parts = val.split('_');
        var pathid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(pathid);
    },
    test: function(val) {
        var parts = val.split('_');
        var testid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(testid);
    },
    id: function(val) {
        var parts = val.split('_');
        var testid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(testid);
    },
};
Table.NA = $('<td style="color:#ccc">NA</td>');
Table.fmtCell = function(row, colname) {
    var val = row[colname];
    var res = undefined;
    if (colname in Table.FORMATTERS) {
        try {
            res = Table.FORMATTERS[colname](val);
        } catch (e) {
            console.log('Formatter failed:', e);
        }
    }
    if (res === undefined) {
        if (val === undefined) {
            res = Table.NA.clone();
        } else if (typeof val === 'string') {
            res = $('<td>').text(val);
        } else {
            var text = JSON.stringify(val);
            if (text.length > 32)
                text = text.substring(0, 32) + '...';
            res = $('<td>').text(text);
        }
    }
    res.css({borderTop: '1px solid #ccc'});
    return res;
};

Table.prototype.refresh = function() {
    var input = this.inputRv.get(this);
    this.limit = 10;
    this._render(input);
    this.outputRv.set(input);
};

Table.prototype._render = function(input) {
    var tthis = this;
    var table = this.table;
    table.empty();

    var th = $('<tr>').appendTo($('<thead>').appendTo(table));

    var haveCols = [];
    var trs = [];
    var prev = {};
    input.forEach(function(row, index) {
        if (index == tthis.limit) {
            table.append(
                $('<tr>').addClass('datatable-more').append(
                    $('<td>').attr({colspan: haveCols.length}).
                        text((input.count() - index) + ' more...')).
                    click(function() {
                        if (tthis.limit < Table.INCREMENT)
                            tthis.limit = 0;
                        tthis.limit += Table.INCREMENT;
                        tthis._render(input);
                    }));
            return false;
        }

        var tr = $('<tr>').addClass('datatable-row').appendTo(table);
        trs.push(tr);

        // XXX Descend into objects

        // Add cells for known columns
        $.each(haveCols, function(_, colname) {
            if (prev[colname] === row[colname]) {
                tr.append($('<td>'));
            } else {
                prev = {};
                tr.append(Table.fmtCell(row, colname));
            }
        });
        prev = row;

        // Add new columns if necessary
        $.each(row, function(colname, _) {
            if (haveCols.indexOf(colname) != -1)
                return;
            if (Table.HIDE.indexOf(colname) != -1)
                return;

            // Add column.  First, is it ordered?
            var order = Table.COL_ORDER.indexOf(colname);
            if (order === -1) {
                var insertAt = haveCols.length;
            } else {
                // Find the insertion point
                for (var insertAt = 0; insertAt < haveCols.length; insertAt++) {
                    var index = Table.COL_ORDER.indexOf(haveCols[insertAt]);
                    if (index > order || index === -1)
                        break;
                }
            }

            if (insertAt == haveCols.length) {
                var add = function(container, obj) {
                    container.append(obj);
                };
            } else {
                var add = function(container, obj) {
                    obj.insertBefore(container.children()[insertAt]);
                };
            }

            // Add this column
            haveCols.splice(insertAt, 0, colname);
            add(th, $('<th>').text(colname));
            $.each(trs, function (_, tr) {
                add(tr, Table.NA.clone());
            });

            // Put in the cell
            Table.fmtCell(row, colname).replaceAll(tr.children()[insertAt]);
        });

        // Make row clickable
        tr.click(function() {
            if (!tr.data('table-info'))
                tthis._addInfo(tr, haveCols.length, row);
            tr.data('table-info').slideToggle();
        });
    });

    // Set column widths
    $('th', th).css({width: (100 / haveCols.length) + '%'});
};

Table.prototype._addInfo = function(tr, ncols, data) {
    var ntr = $('<tr>').addClass('datatable-info'), div;
    ntr.append($('<td>').attr({colspan: ncols}).append(div = $('<div>')));
    div.hide();
    tr.after(ntr).data('table-info', div);

    div.append($('<pre>').css({font: 'inherit', whiteSpace: 'pre-wrap'}).
               text(JSON.stringify(data, null, '  ')));
};

//
// Setup
//

var database;

$(document).ready(function() {
    var qc = new QueryCanvas($('#container'));
    qc.heatmap(function(tc) { return tc.shared.length; },
               function(tc) { return tc.runid; });
    qc.table();

    database = [];

    // XXX Error handling, load indicator, clean up
    // $.getJSON('data/linux.json').
    //     done(function(json) {
    //         database = database.concat(databaseFromJSON(json));
    //         qc.setInput(Enumerable.from(database).orderBy('$.test'));
    //     });
    $.getJSON('data/sv6.json').
        done(function(json) {
            database = database.concat(databaseFromJSON(json));
            qc.setInput(Enumerable.from(database).orderBy('$.id'));
        });
});