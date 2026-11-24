import { baseCss, certificateCss, themeVars } from './styles.js';
import { esc, header, signature, verificationPanel, footer, watermark, page, fitPt } from './components.js';

// Internship Completion Certificate, A4 landscape, exactly one page. Long names and titles shrink (fitPt) instead of clipping.
// The completion wording is only reachable through data.js buildCertificateData, which refuses unless the backend confirms completion.
export const certificateTemplate = {
  type: 'certificate', version: 'certificate@1', paper: { size: 'A4', orientation: 'landscape' },
  render(d) {
    const org = d.organization, pv = d.preview;
    const nameSize = fitPt(d.student.fullName, { base: 30, min: 18, free: 28 });
    const titleSize = fitPt(d.internship.title, { base: 13, min: 10, free: 60 });
    const body = `<div class="sheet">${watermark(pv)}<div class="frame">
      ${header(org, pv)}
      <div class="ctitle serif">Certificate of Completion</div>
      <div class="csub">This is to certify that</div>
      <div class="cname serif" style="font-size:${nameSize}pt">${esc(d.student.fullName)}</div>
      <p class="cbody">has successfully completed the internship <strong style="font-size:${titleSize}pt">${esc(d.internship.title)}</strong>${d.internship.category ? ` in ${esc(d.internship.category)}` : ''}
        with ${esc(org.name)}${d.internship.duration ? `, a programme of ${esc(d.internship.duration)}` : ''}.</p>
      <div class="facts">
        <div>Start date<b>${esc(d.dates.start)}</b></div><div>Completion date<b>${esc(d.dates.completion)}</b></div>
        <div>Issue date<b>${esc(d.document.issueDate)}</b></div><div>Elvora ID<b>${esc(d.document.number)}</b></div></div>
      <div class="cfoot">${signature(org, pv)}${verificationPanel(d.document)}</div>
      ${footer(org)}</div></div>`;
    return page({ title: `${d.title} — ${d.student.fullName}`, css: themeVars(org.colors) + baseCss + certificateCss, body });
  },
};
