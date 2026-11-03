"""Worn Type — font writer.

Adds the worn alternates to a copy of the source font: glyphs `<base>.wornN`
with the same advance widths, GSUB `rand`/`calt`/`salt`/`ssNN` to swap them in,
and the base glyph's kerning / mark anchors / GDEF classes copied over.

Runs in the browser (Pyodide, see save-worker.js) and in plain Python.
"""
import io
import re
import time
from copy import deepcopy

from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import otTables as ot
from fontTools.otlLib import builder as otl

# ---------------------------------------------------------------- font writing

def signed_area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts))) / 2


def draw_contours(pen, contours, cff):
    """contours: [{pts:[[x,y]..], hole:bool}] in font units, y-up.
    TrueType wants outer contours clockwise, CFF counter-clockwise."""
    for c in contours:
        pts = [(round(x), round(y)) for x, y in c["pts"]]
        # drop consecutive duplicates created by rounding
        clean = [p for i, p in enumerate(pts) if p != pts[i - 1]]
        if len(clean) < 3:
            continue
        ccw = signed_area(clean) > 0
        want_ccw = (not c["hole"]) if cff else c["hole"]
        if ccw != want_ccw:
            clean.reverse()
        pen.moveTo(clean[0])
        for p in clean[1:]:
            pen.lineTo(p)
        pen.closePath()


def unique_names(order, base, n):
    have = set(order)
    tag = "worn"
    k = 1
    while any(f"{base}.{tag}{i + 1}" in have for i in range(n)):
        k += 1
        tag = f"worn{k}_"
    return [f"{base}.{tag}{i + 1}" for i in range(n)]


def add_glyph_glyf(font, name, base, contours):
    pen = TTGlyphPen(None)
    draw_contours(pen, contours, cff=False)
    g = pen.glyph()
    font["glyf"][name] = g
    g.recalcBounds(font["glyf"])
    adv = font["hmtx"][base][0]
    font["hmtx"][name] = (adv, getattr(g, "xMin", 0))


def add_glyph_cff(font, name, base, contours):
    cff = font["CFF "].cff
    top = cff.topDictIndex[0]
    adv = font["hmtx"][base][0]
    css = top.CharStrings
    if hasattr(top, "FDSelect"):  # CID-keyed
        fd = top.FDSelect[font.getGlyphID(base)]
        private = top.FDArray[fd].Private
    else:
        fd = None
        private = top.Private
    pen = T2CharStringPen(adv, None)
    draw_contours(pen, contours, cff=True)
    cs = pen.getCharString(private=private, globalSubrs=cff.GlobalSubrs)
    if css.charStringsAreIndexed:
        css.charStrings[name] = len(css.charStringsIndex)
        css.charStringsIndex.append(cs)
    else:
        css.charStrings[name] = cs
    top.charset.append(name)
    if fd is not None:
        top.FDSelect.append(fd)
    font["hmtx"][name] = (adv, 0)


def ensure_gsub(font):
    if "GSUB" in font:
        return font["GSUB"].table
    t = ot.GSUB()
    t.Version = 0x00010000
    t.ScriptList = ot.ScriptList()
    t.ScriptList.ScriptRecord = []
    for tag in ("DFLT", "latn"):
        sr = ot.ScriptRecord()
        sr.ScriptTag = tag
        sr.Script = ot.Script()
        sr.Script.DefaultLangSys = ot.LangSys()
        sr.Script.DefaultLangSys.ReqFeatureIndex = 0xFFFF
        sr.Script.DefaultLangSys.FeatureIndex = []
        sr.Script.LangSysRecord = []
        t.ScriptList.ScriptRecord.append(sr)
    t.FeatureList = ot.FeatureList()
    t.FeatureList.FeatureRecord = []
    t.LookupList = ot.LookupList()
    t.LookupList.Lookup = []
    font["GSUB"] = newTable("GSUB")
    font["GSUB"].table = t
    return t


def add_lookup(gsub, lookup):
    gsub.LookupList.Lookup.append(lookup)
    return len(gsub.LookupList.Lookup) - 1


def lang_systems(gsub):
    for sr in gsub.ScriptList.ScriptRecord:
        if sr.Script.DefaultLangSys:
            yield sr.Script.DefaultLangSys
        for lr in sr.Script.LangSysRecord:
            yield lr.LangSys


def add_feature(gsub, tag, lookup_indices):
    """Shapers use only the first record of a tag per language system, so
    where the font already has this feature, extend it instead of adding one."""
    recs = gsub.FeatureList.FeatureRecord
    new_idx = None
    for ls in lang_systems(gsub):
        existing = [i for i in ls.FeatureIndex if recs[i].FeatureTag == tag]
        for i in existing:
            li = recs[i].Feature.LookupListIndex
            li.extend(l for l in lookup_indices if l not in li)
        if existing:
            continue
        if new_idx is None:
            fr = ot.FeatureRecord()
            fr.FeatureTag = tag
            fr.Feature = ot.Feature()
            fr.Feature.FeatureParams = None
            fr.Feature.LookupListIndex = list(lookup_indices)
            recs.append(fr)
            new_idx = len(recs) - 1
        ls.FeatureIndex.append(new_idx)


def sort_features(gsub):
    """Keep FeatureList in tag order (spec recommendation), remapping indices."""
    if getattr(gsub, "FeatureVariations", None):
        return
    recs = gsub.FeatureList.FeatureRecord
    order = sorted(range(len(recs)), key=lambda i: recs[i].FeatureTag)
    remap = {old: new for new, old in enumerate(order)}
    gsub.FeatureList.FeatureRecord = [recs[i] for i in order]
    for ls in lang_systems(gsub):
        ls.FeatureIndex = sorted(remap[i] for i in ls.FeatureIndex)
        if ls.ReqFeatureIndex != 0xFFFF:
            ls.ReqFeatureIndex = remap[ls.ReqFeatureIndex]


def bucket(gid, n):
    """Scatter glyph IDs over n buckets. Plain gid % n would line up with how
    alternates are numbered (base.worn1..N in a row) and repeat one pattern."""
    return (((gid * 2654435761) & 0xFFFFFFFF) >> 11) % n


def add_substitutions(font, alts_of):
    """alts_of: {base: [alt1..altN]}.
    calt: pseudo-random cycling keyed on the preceding glyph.
    rand: random alternate (HarfBuzz);  salt: all alternates;
    first N unused ssNN: force one alternate."""
    gsub = ensure_gsub(font)
    order = font.getGlyphOrder()
    gmap = font.getReverseGlyphMap()
    n = min(len(a) for a in alts_of.values())

    singles = []
    for k in range(n):
        lk = otl.buildLookup([otl.buildSingleSubstSubtable({b: a[k] for b, a in alts_of.items()})])
        singles.append(add_lookup(gsub, lk))
    alt_lk = add_lookup(gsub, otl.buildLookup([otl.buildAlternateSubstSubtable({b: list(a) for b, a in alts_of.items()})]))

    # bucket every glyph by index: the preceding glyph's bucket picks the
    # alternate, so every letter is worn but neighbours rarely repeat
    buckets = n
    bases = list(alts_of)
    subtables = []
    for k in range(1, buckets + 1):
        prev = [g for i, g in enumerate(order) if bucket(i, buckets) == k - 1]
        if not prev:
            continue
        st = ot.ChainContextSubst()
        st.Format = 3
        st.BacktrackGlyphCount = 1
        st.BacktrackCoverage = [otl.buildCoverage(prev, gmap)]
        st.InputGlyphCount = 1
        st.InputCoverage = [otl.buildCoverage(bases, gmap)]
        st.LookAheadGlyphCount = 0
        st.LookAheadCoverage = []
        rec = ot.SubstLookupRecord()
        rec.SequenceIndex = 0
        rec.LookupListIndex = singles[k - 1]
        st.SubstCount = 1
        st.SubstLookupRecord = [rec]
        subtables.append(st)
    chain = otl.buildLookup(subtables)
    chain.LookupType = 6
    chain_lk = add_lookup(gsub, chain)
    # a glyph with nothing before it (start of a run) still gets worn
    first_lk = add_lookup(gsub, otl.buildLookup([otl.buildSingleSubstSubtable({b: a[0] for b, a in alts_of.items()})]))

    # rand: HarfBuzz (Chrome, Firefox, Android, most design apps) picks a
    # random alternate per glyph — works inside Indic syllables, where calt
    # can't see the previous letter. calt is the fallback for CoreText.
    add_feature(gsub, "rand", [alt_lk])
    add_feature(gsub, "calt", [chain_lk, first_lk])
    add_feature(gsub, "salt", [alt_lk])
    taken = {r.FeatureTag for r in gsub.FeatureList.FeatureRecord}
    free = [t for t in (f"ss{i:02d}" for i in range(1, 21)) if t not in taken]
    sets = list(zip(free, singles))
    for tag, lk in sets:
        add_feature(gsub, tag, [lk])
    sort_features(gsub)
    gsub.LookupList.LookupCount = len(gsub.LookupList.Lookup)
    return [tag for tag, _ in sets]


# ---------------------------------------------------------------- GPOS / GDEF

class Cloner:
    """Gives each alternate the same positioning data as its base glyph:
    kerning, mark anchors (matras!), cursive joins, GDEF classes.
    Alternates have the highest glyph IDs and are appended in ID order,
    so coverages stay sorted."""

    def __init__(self, pairs):
        self.pairs = pairs  # [(base, alt)] in alt glyph-ID order

    def cov(self, cov, records=None):
        if cov is None:
            return
        idx = {g: i for i, g in enumerate(cov.glyphs)}
        for base, alt in self.pairs:
            if base in idx:
                cov.glyphs.append(alt)
                if records is not None:
                    records.append(deepcopy(records[idx[base]]))

    def classdef(self, cd):
        if cd is None:
            return
        for base, alt in self.pairs:
            if base in cd.classDefs:
                cd.classDefs[alt] = cd.classDefs[base]

    def gpos_subtable(self, st, typ):
        if typ == 9:
            return self.gpos_subtable(st.ExtSubTable, st.ExtensionLookupType)
        f = getattr(st, "Format", 1)
        if typ == 1:
            self.cov(st.Coverage, st.Value if f == 2 else None)
        elif typ == 2:
            if f == 1:
                for ps in st.PairSet:
                    by_second = {r.SecondGlyph: r for r in ps.PairValueRecord}
                    for base, alt in self.pairs:
                        if base in by_second:
                            r = deepcopy(by_second[base])
                            r.SecondGlyph = alt
                            ps.PairValueRecord.append(r)
                self.cov(st.Coverage, st.PairSet)
            else:
                self.classdef(st.ClassDef1)
                self.classdef(st.ClassDef2)
                self.cov(st.Coverage)
        elif typ == 3:
            self.cov(st.Coverage, st.EntryExitRecord)
        elif typ == 4:
            self.cov(st.MarkCoverage, st.MarkArray.MarkRecord)
            self.cov(st.BaseCoverage, st.BaseArray.BaseRecord)
        elif typ == 5:
            self.cov(st.MarkCoverage, st.MarkArray.MarkRecord)
            self.cov(st.LigatureCoverage, st.LigatureArray.LigatureAttach)
        elif typ == 6:
            self.cov(st.Mark1Coverage, st.Mark1Array.MarkRecord)
            self.cov(st.Mark2Coverage, st.Mark2Array.Mark2Record)
        elif typ in (7, 8):
            # contextual: let alternates trigger the same rules where coverage-based
            if f == 1:
                self.cov(st.Coverage, st.PosRuleSet if typ == 7 else st.ChainPosRuleSet)
            elif f == 2:
                self.cov(st.Coverage)
                for name in ("ClassDef", "BacktrackClassDef", "InputClassDef", "LookAheadClassDef"):
                    self.classdef(getattr(st, name, None))
            else:
                for name in ("Coverage", "BacktrackCoverage", "InputCoverage", "LookAheadCoverage"):
                    for c in getattr(st, name, None) or []:
                        self.cov(c)

    def run(self, font):
        if "kern" in font:  # legacy pair kerning (older Mac/Windows fonts)
            alts = {}
            for base, alt in self.pairs:
                alts.setdefault(base, []).append(alt)
            for sub in font["kern"].kernTables:
                if getattr(sub, "format", None) != 0:
                    continue
                table = dict(sub.kernTable)
                for (l, r), v in sub.kernTable.items():
                    for l2 in [l] + alts.get(l, []):
                        for r2 in [r] + alts.get(r, []):
                            table.setdefault((l2, r2), v)
                if len(table) < 10900:  # format 0 subtables have a 16-bit length
                    sub.kernTable = table
        if "GPOS" in font:
            for lk in font["GPOS"].table.LookupList.Lookup:
                for st in lk.SubTable:
                    self.gpos_subtable(st, lk.LookupType)
        if "GDEF" in font:
            g = font["GDEF"].table
            self.classdef(g.GlyphClassDef)
            self.classdef(getattr(g, "MarkAttachClassDef", None))
            if getattr(g, "MarkGlyphSetsDef", None):
                for c in g.MarkGlyphSetsDef.Coverage:
                    self.cov(c)
            if getattr(g, "LigCaretList", None):
                self.cov(g.LigCaretList.Coverage, g.LigCaretList.LigGlyph)
            if getattr(g, "AttachList", None):
                self.cov(g.AttachList.Coverage, g.AttachList.AttachPoint)


def rename(font, suffix):
    name = font["name"]
    fam = name.getBestFamilyName() or "Font"
    sub = name.getBestSubFamilyName() or "Regular"
    new_fam = f"{fam} {suffix}"
    ps = re.sub(r"[^A-Za-z0-9-]", "", f"{new_fam.replace(' ', '')}-{sub.replace(' ', '')}")[:62]
    for rec in list(name.names):
        if rec.nameID in (1, 16):
            rec.string = new_fam
        elif rec.nameID == 4:
            rec.string = f"{new_fam} {sub}" if sub != "Regular" else new_fam
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = f"{ps};{time.strftime('%Y%m%d%H%M')}"
    if "CFF " in font:
        cff = font["CFF "].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        for attr in ("FullName", "FamilyName"):
            if hasattr(top, attr):
                setattr(top, attr, new_fam)
    return new_fam, ps


def save_worn(data, items, suffix):
    """data: the source font file's bytes. items: [{gid, variants: [{contours}, ...]}],
    every item with the same number of variants. Returns the new font's bytes + facts."""
    font = TTFont(io.BytesIO(data))
    if "CFF2" in font:
        raise ValueError("CFF2 fonts aren't supported yet")
    if "fvar" in font:
        from fontTools.varLib import instancer
        font = instancer.instantiateVariableFont(font, {})
    order = list(font.getGlyphOrder())
    cff = "CFF " in font

    alts_of, new_names, pairs = {}, [], []
    for it in items:
        base = order[int(it["gid"])]
        if ".worn" in base or base == ".notdef" or base in alts_of:
            continue
        names = unique_names(order + new_names, base, len(it["variants"]))
        alts_of[base] = names
        new_names += names
        pairs += [(base, n) for n in names]
    if not alts_of:
        raise ValueError("Nothing to save")

    font.setGlyphOrder(order + new_names)
    if not cff:
        font["glyf"].glyphOrder = order + new_names
    by_base = {order[int(it["gid"])]: it for it in items}
    for base, names in alts_of.items():
        for name, v in zip(names, by_base[base]["variants"]):
            (add_glyph_cff if cff else add_glyph_glyf)(font, name, base, v["contours"])
            if "vmtx" in font:
                font["vmtx"][name] = font["vmtx"][base]
    for tag in ("hdmx", "LTSH", "VDMX", "DSIG"):
        if tag in font:
            del font[tag]

    Cloner(pairs).run(font)
    stylistic_sets = add_substitutions(font, alts_of)
    family, ps = rename(font, suffix)

    buf = io.BytesIO()
    font.save(buf)
    out = buf.getvalue()
    return {
        "data": out, "file": ps + (".otf" if cff else ".ttf"), "family": family,
        "count": len(alts_of), "added": len(new_names), "sets": stylistic_sets, "size": len(out),
    }
