import fs from 'node:fs';

const hoverImagePath = 'web/src/components/HoverImage.tsx';
const ordersViewPath = 'web/src/components/Views/OrdersView.tsx';

const hoverImage = fs.readFileSync(hoverImagePath, 'utf8');
const ordersView = fs.readFileSync(ordersViewPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  hoverImage.includes('document.documentElement.appendChild(el)'),
  'HoverImage preview must be portal-mounted outside the zoomed body so right-side panel previews stay visible.',
);

assert(
  !hoverImage.includes('document.body.appendChild(el)'),
  'HoverImage preview must not be mounted under document.body because body zoom can push fixed previews offscreen.',
);

assert(
  !hoverImage.includes('rawLeft / zoom') && !hoverImage.includes('rawTop / zoom'),
  'HoverImage positioning must use viewport coordinates directly after moving the preview outside the zoomed body.',
);

const panelItemsStart = ordersView.indexOf('id="sec-items"');
const panelRecipientStart = ordersView.indexOf('id="sec-recipient"', panelItemsStart);
assert(panelItemsStart >= 0 && panelRecipientStart > panelItemsStart, 'Could not locate side-panel items section in OrdersView.');

const panelItemsSection = ordersView.slice(panelItemsStart, panelRecipientStart);
assert(
  panelItemsSection.includes('<HoverImage') &&
    panelItemsSection.includes('src={item.imageUrl}') &&
    panelItemsSection.includes('size={42}'),
  'Side-panel item thumbnails must use HoverImage with the item image URL.',
);

console.log('Side-panel hover image preview guard passed.');
