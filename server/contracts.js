// Contract text builders for Producer Agreement and Beat Licensing Agreement.
// These are used when generating license PDFs and onboarding producers.

export function buildProducerAgreement({ date, producerName }) {
  const safeDate = date || new Date().toISOString().slice(0, 10)
  const safeName = producerName || 'Producer'
  return `
RIDDIMBASE LLC — PRODUCER AGREEMENT

Effective Date: ${safeDate}
Producer Name: ${safeName}
Platform: RiddimBase LLC (“Company”)
Territory: Worldwide
Agreement Type: Producer Content Licensing & Distribution Agreement

1. Appointment

The Producer appoints RiddimBase LLC as a non-exclusive digital distributor to:
- Host, market, promote, and sell Producer’s beats
- Collect payments from buyers
- Deliver digital products to buyers
- Generate beat licensing contracts automatically
- Issue payouts to Producers based on licensing terms

Producer retains 100% ownership of all uploaded beats.

2. Grant of Rights

The Producer grants the Company:
- A worldwide, royalty-free license to host and display beats on the platform
- The right to generate Buyer Licensing Agreements automatically
- The right to process payments and collect commissions
- The right to advertise the Producer’s beats in marketing content

The Company does NOT receive ownership or exclusive rights to any beats.

3. License Types Available to Buyers

RiddimBase LLC will sell Producer’s beats under the following licensing tiers:

- Basic License
- Premium License
- Unlimited License
- Exclusive Rights

The specific usage, delivery and monetization limits are outlined in the Buyer Beat Licensing Agreement delivered with each purchase.

4. Compensation

RiddimBase LLC will process payments and distribute earnings as follows:
- Producer receives 85% of every beat sale
- RiddimBase LLC retains 15% platform commission
- Payment processors may charge additional fees (PayPal, Stripe, etc.)

Payouts:
- Producers may withdraw earnings once available
- Withdrawals are processed via supported payout methods
- No withdrawal fee charged by RiddimBase LLC

5. Warranties

Producer warrants that:
- All beats are original works
- No samples or copyrighted materials are used without clearance
- Producer owns sufficient rights to upload and sell the beats

RiddimBase LLC is not liable for copyright disputes between Producer and any third party.

6. Removal of Beats

Producer may remove beats at any time EXCEPT:
- Beats sold as Exclusive Rights cannot be re-uploaded
- Sales made prior to removal remain valid contracts

7. Term & Termination

This agreement continues until:
- Producer deletes their account, or
- RiddimBase LLC terminates for violation of terms

Existing licenses remain valid beyond termination.

8. Governing Law

This agreement is governed by the laws of Delaware, USA.

9. Signatures

Producer:
${safeName}

RiddimBase LLC Authorized Representative:
RiddimBase LLC
Official Platform Signature
`.trim()
}

export function buildBeatLicenseContract({
  date,
  buyerName,
  producerName,
  beatTitle,
  licenseType,
  orderId,
}) {
  const safeDate = date || new Date().toISOString().slice(0, 10)
  const buyer = buyerName || 'Buyer'
  const producer = producerName || 'Producer'
  const title = beatTitle || 'Beat'
  const license = licenseType || 'Basic'
  const txId = orderId || 'N/A'

  return `
RIDDIMBASE LLC — BEAT LICENSING CONTRACT

Effective Date: ${safeDate}
Buyer (Artist) Name: ${buyer}
Producer: ${producer}
Beat Title: ${title}
License Type: ${license}
Transaction ID: ${txId}

1. Grant of License

Producer hereby grants Buyer the following rights according to the purchased license tier as described in the platform listing and license certificate.

A. BASIC LICENSE
- Delivery: MP3
- Streams allowed: Up to 5,000
- Performances: Non-profit only
- Music videos: Not allowed
- Radio rotation: Not allowed
- Monetization: Not allowed
- Credit Required: “Prod. by ${producer}”
- Non-exclusive
- Expiration: 3 years

B. PREMIUM LICENSE
- Delivery: MP3 + WAV
- Streams allowed: Up to 100,000
- 1 music video allowed
- Radio rotation: Allowed
- Monetization: Allowed
- Performances: Paid or free
- Non-exclusive
- Expiration: 5 years

C. UNLIMITED LICENSE
- Delivery: MP3 + WAV + Stems (where available)
- Streams allowed: Unlimited
- Music videos: Unlimited
- Monetization: Fully allowed
- Performances: Unlimited
- Radio rotation: Unlimited
- Non-exclusive
- Expiration: Never expires (lifetime licensing)

D. EXCLUSIVE RIGHTS
- Delivery: MP3 + WAV + Stems
- Beat removed from marketplace immediately
- Streams: Unlimited
- Music videos: Unlimited
- Monetization: Fully allowed
- Buyer receives full exclusive rights for own use
- License does not expire
- Producer may not resell or reuse the beat

2. Restrictions for All Licenses

The Buyer MAY NOT:
- Claim exclusive rights unless Exclusive Rights were purchased
- Sell, lease, or distribute the beat standalone
- Register the beat with Content ID or publishing as their own work only

3. Credit Requirements

Buyer MUST credit producer as:
“Prod. by ${producer}”

On:
- Spotify / Apple Music and other DSP releases
- YouTube videos
- Social media posts
- Album / single metadata

4. Performance Rights

Buyer may perform the song live within the scope of the licensed tier (Basic / Premium / Unlimited / Exclusive).

5. Publishing Splits

Unless otherwise negotiated privately:
- Producer retains 50% publishing
- Buyer retains 50% publishing

This applies only to monetized releases and should be reflected in PRO registrations where applicable.

6. Delivery

RiddimBase LLC will deliver files instantly via:
- Email receipt
- Buyer dashboard
- Download page

7. Legal Disclaimer

RiddimBase LLC is not a legal party in the licensing agreement.
RiddimBase LLC only facilitates payment & delivery.
All copyright and legal responsibility lies between Buyer and Producer.

8. Governing Law

This agreement is governed by the laws of Delaware, USA.

9. Signatures

Buyer (Artist):
${buyer}

Producer:
${producer}

RiddimBase LLC (Platform Facilitator):
Official Platform Signature
`.trim()
}

