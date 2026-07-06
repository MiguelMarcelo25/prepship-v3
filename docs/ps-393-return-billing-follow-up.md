# PS-393 Return Billing Follow-up

PS-393 adds the backend-owned Billing Status contract and display/export support
for return line items when return billing rows exist.

Current gap: PrepShip has return label records (`return_labels`) and return
shipment creation, but there is no approved billing source of truth that turns
those records into customer-billed return fee line items.

Do not add return fees by mutating the original fulfillment row. The next return
billing ticket should define the backend owner that reads return label records,
creates separate billing line items (`return`, `return_label`, or
`return_processing`), and proves client scope, invoice totals, and no live label
or production order mutation.
