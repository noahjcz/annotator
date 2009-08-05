// Selection and range creation reference for the following code:
// http://www.quirksmode.org/dom/range_intro.html
//
// I've removed any support for IE TextRange (see commit d7085bf2 for code)
// for the moment, having no means of testing it.

var Annotator = DelegatorClass.extend({
    // Class used to identify elements owned/created by the annotator.
    className: 'jsannotate',
    annotations: [],
    
    events: {
        'body mouseup': 'checkForSelection',
        '#noteIcon img mousedown': 'createAnnotation'
    },

    init: function () {
        this._super();
        this.noteIcon = $('#noteIcon');
    },

    checkForSelection: function (e) {
        // This prevents the note image from jumping away on the mouseup
        // of a click on icon.
        if (this.ignoreMouseup) {
            this.ignoreMouseup = false;
            return;
        }

        this.getSelection();

        if (e && this.validSelection()) {
            this.noteIcon.show().css({
                top: e.pageY - 25,
                left: e.pageX + 3
            });
        } else {
            this.noteIcon.hide();
        }
    },
    
    getSelection: function () {
        // TODO: fail gracefully in IE. 
        this.selection = window.getSelection();
        this.selectedRanges = [];
        for(var ii = 0; ii < this.selection.rangeCount; ii += 1) {
            this.selectedRanges.push(this.selection.getRangeAt(ii));
        }
    },

    validSelection: function () {
        return this.selection && 
               this.selection.rangeCount > 0 && 
              !this.selection.isCollapsed;
    },

    createAnnotation: function (e) {
        this.register({ ranges: this.selectedRanges }, true);

        this.ignoreMouseup = true;
        this.noteIcon.hide();
        return false;
    },

    register: function (annotation, fromBrowser) {
        var annotator = this;
        annotation.text = annotation.text || "";
        annotation.ranges = annotation.ranges || [];

        annotation.ranges = $.map(annotation.ranges, function (r) {
            var normed = fromBrowser ? annotator.normRange(r) : r;
            annotator.highlightRange(normed);
            return annotator.serializeRange(normed);
        });

        this.annotations.push(annotation);
    },
    
    // normRange: works around the fact that browsers don't generate 
    // ranges/selections in a consistent manner. Some (Safari) will create 
    // ranges that have (say) a textNode startContainer and elementNode 
    // endContainer. Others (Firefox) seem to only ever generate 
    // textNode/textNode or elementNode/elementNode pairs. 
    //
    // This will return a (start, end, commonAncestor) triple, where start and 
    // end are textNodes, and commonAncestor is an elementNode.
    //
    // NB: This method may well split textnodes (i.e. alter the DOM) to 
    // achieve this.
    normRange: function (range) {
        var r = {}, nr = {};

        $.each(['start', 'end'], function (idx, p) {
            var it, node = range[p + 'Container'], offset = range[p + 'Offset'];

            if(node.nodeType === Node.ELEMENT_NODE) {
                // Get specified node.
                it = node.childNodes[offset];
                // If it doesn't exist, that means we need the end of the 
                // previous one.
                node = it || node.childNodes[offset - 1];
                while(node.nodeType !== Node.TEXT_NODE) { node = node.firstChild; }
                offset = it ? 0 : node.nodeValue.length;
            }

            r[p] = node;
            r[p + 'Offset'] = offset;
        });

        nr.start = (r.startOffset > 0) ? r.start.splitText(r.startOffset) : r.start;
        
        if (r.start === r.end) {
            if ((r.endOffset - r.startOffset) < nr.start.nodeValue.length)
                nr.start.splitText(r.endOffset - r.startOffset);
            nr.end = nr.start;
        } else {
            if (r.endOffset < r.end.nodeValue.length)
                r.end.splitText(r.endOffset);
            nr.end = r.end;
        }

        // Make sure the common ancestor is an element node.
        nr.commonAncestor = range.commonAncestorContainer;
        while(nr.commonAncestor.nodeType !== Node.ELEMENT_NODE) { 
            nr.commonAncestor = nr.commonAncestor.parentNode;
        }

        return nr;
    },

    highlightRange: function (normedRange) {
        var annotator = this;
        var textNodes = $(normedRange.commonAncestor).textNodes();

        textNodes.slice(textNodes.index(normedRange.start), 
                        textNodes.index(normedRange.end) + 1).each(function () {
                      $(this).wrap('<span class="' + annotator.className + ' highlight"></span>');
                  });
    },

    // serializeRange: takes a normedRange and turns it into a 
    // serializedRange, which is two pairs of (xpath, character offset), which 
    // can be easily stored in a database and loaded through 
    // #loadAnnotations/#deserializeRange.
    serializeRange: function (normedRange) {
        var annotator = this;
        var serialization = function (node, isEnd) { 
            var origParent = $(node).parents(':not(.' + annotator.className + ')').eq(0),
                xpath = origParent.xpath().get(0),
                textNodes = origParent.textNodes(),
                
                // Calculate real offset as the combined length of all the 
                // preceding textNode siblings. We include the length of the 
                // node if it's the end node.
                offset = $.inject(textNodes.slice(0, textNodes.index(node)), 
                                  0, 
                                  function (acc, tn) { return acc + tn.nodeValue.length; });

            return isEnd ? [xpath, offset + node.nodeValue.length] : [xpath, offset];
        },

        start = serialization(normedRange.start),
        end   = serialization(normedRange.end, true);

        return {
            // XPath strings
            start: start[0],
            end: end[0],
            // Character offsets (integer)
            startOffset: start[1],
            endOffset: end[1]
        };
    },

    deserializeRange: function (serializedRange) {
        var nodeFromXPath = function (xpath) {
            return document.evaluate(xpath, document, null, 
                                     XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        };

        var startAncestry = serializedRange.start.split("/"),
            endAncestry   = serializedRange.end.split("/"),
            common = [],
            range = {};

        // Crudely find a near common ancestor by walking down the XPath from 
        // the root until the segments no longer match.
        for (var ii = 0; ii < startAncestry.length; ii += 1) {
            if (startAncestry[ii] === endAncestry[ii]) {
                common.push(startAncestry[ii]);
            } else {
                break;
            }
        }

        range.commonAncestorContainer = nodeFromXPath(common.join("/"));

        // Unfortunately, we *can't* guarantee only one textNode per 
        // elementNode, so we have to walk along the element's textNodes until 
        // the combined length of the textNodes to that point exceeds or 
        // matches the value of the offset.
        $.each(['start', 'end'], function () {
            var which = this, length = 0;
            $(nodeFromXPath(serializedRange[this])).textNodes().each(function () {
                if (length + this.nodeValue.length >= serializedRange[which + 'Offset']) {
                    range[which + 'Container'] = this;
                    range[which + 'Offset'] = serializedRange[which + 'Offset'] - length;
                    return false; // end each loop.
                } else {
                    length += this.nodeValue.length;
                    return true;
                }
            });
        });

        return this.normRange(range);
    },

    clearAll: function () {
        this.annotations = [];
        $('.' + this.className).each(function () {
            $(this).replaceWith($(this).text());
        });
    },

    loadAnnotations: function (annotations) {
        var annotator = this;
        $.each(annotations, function () {
            annotator.register(this); 
        });
    },
    
    dumpAnnotations: function () {
        return this.annotations;
    }
});

