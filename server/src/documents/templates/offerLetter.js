import { baseCss, offerCss, themeVars } from './styles.js';
import { esc, header, numberRow, detailGrid, section, bulletList, signature, verificationPanel, footer, watermark, page } from './components.js';

// Internship Offer Letter, A4 portrait. Flows onto a second page when terms or objectives are long; blocks never split mid-item.
export const offerLetterTemplate = {
  type: 'offer_letter', version: 'offer-letter@1', paper: { size: 'A4', orientation: 'portrait' },
  render(d) {
    const org = d.organization, pv = d.preview;
    const body = `<div class="sheet">${watermark(pv)}${header(org, pv)}
      <div class="rule"></div>
      ${numberRow(d.document)}
      <div class="eyebrow" style="margin-top:14px">Internship</div>
      <h1 class="title">${esc(d.title)}</h1>
      <div class="lead"><p class="salute">Dear <strong>${esc(d.student.fullName)}</strong>,</p>
        <p>We are pleased to offer you an internship with ${esc(org.name)} as described below. This offer follows the approval of your application.</p></div>
      ${section('Offer details', detailGrid([
        ['Intern', d.student.fullName], ['Email', d.student.email], ['Internship', d.internship.title], ['Category', d.internship.category],
        ['Duration', d.internship.duration], ['Start date', d.dates.start], ['Expected completion', d.dates.expectedEnd], ['Assigned project', d.offer.project],
      ]))}
      ${d.offer.objectives.length ? section('Responsibilities and learning objectives', bulletList(d.offer.objectives)) : ''}
      ${section('Terms and conditions', bulletList(d.offer.terms, 'ol'), 'terms')}
      <div class="sign">${signature(org, pv)}${verificationPanel(d.document)}</div>
      ${footer(org)}</div>`;
    return page({ title: `${d.title} — ${d.student.fullName}`, css: themeVars(org.colors) + baseCss + offerCss, body });
  },
};
