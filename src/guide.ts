export const RAW_GUIDE_URI = "jev://raw-decisions";

/**
 * Read on demand, never in the tool description. The description carries the
 * trigger; this carries the shapes.
 */
export const RAW_GUIDE = `# Writing raw Jev decisions

Jev answers one bounded question at a time. It returns a typed answer plus a
probability for every option. It generates no text, reads no images, and never
invents an option you did not list.

Use \`use_jev_raw\` when the judgment has no page in it. Use \`run_action\` when
the judgment is about a live page.

## When raw beats a browser step

- Two or more options read equally good and you want a calibrated pick.
- A tie-break you would otherwise settle at random.
- A gate before a costly or risky action.
- A rank over candidates you already collected.
- A screen: does this text meet the bar, yes or no.

Wrong tool for anything needing an explanation, a plan, or a written answer.
Write those yourself.

## The three question types

| type | Answers | Comes back as |
| --- | --- | --- |
| \`choice\` | Which one of these? | \`choice\`, \`probabilities\`, \`confidence\` |
| \`score\` | Which level? | \`score\`, \`legend\`, \`probabilities\`, \`confidence\` |
| \`noul\` | Is this true? | \`noul\`, a number from 0 to 1 |

Pick \`choice\` when the options have no order. Pick \`score\` when they sit on a
spectrum you can describe. Pick \`noul\` for a yes or no where the probability
itself is the signal. A \`noul\` of 0.5 means Jev splits between yes and no. It
does not mean "medium".

## Write the question

Every question needs an id you pick, a \`type\`, and \`instructions\`.

- The id is for your code. Jev never sees it. Put the whole question in
  \`instructions\`.
- Write \`instructions\` literally. Name the subject, the condition, and what
  counts. Jev reads them as written.
- \`criteria\` holds the options for a \`choice\`, the ordered levels for a
  \`score\`, and the meaning of each answer for a \`noul\`.
- A \`choice\` keys \`criteria\` by your own option names. A \`score\` takes an
  array, lowest level first. A \`noul\` keys it by \`true\` and \`false\`, and
  those two spellings are the only ones it accepts.

\`criteria\` rules:

- Describe each option. A bare label makes Jev guess what it means.
- Keep options mutually exclusive. Overlapping options split one probability
  in two and lower confidence for no reason.
- Cover the input. Add an \`other\` or \`none\` option when the list can miss.
- A \`choice\` takes up to 255 options. A \`score\` takes 2 to 10 levels.

## Ask everything in one call

Questions in one call share the state and answer in parallel. Extra questions
cost their own tokens and almost no extra time, so include the ones that only
matter for some inputs and ignore the answers you do not need.

Questions never see each other's answers. When a later question depends on an
earlier answer, make a second call.

## Write the state

\`state\` is a plain string, or JSON when the content has parts. Give each part
a named field. Point a question at one part by naming its path in backticks,
for example \`Does \\\`ticket.messages[0].text\\\` ask for a refund?\`.

Keep the state to what the question needs. Ceilings:

- 64,000 tokens for the whole request.
- 32,000 tokens for the state plus the longest single question.

## Read the answer

\`probabilities\` is the spread over your options. \`confidence\` summarizes how
peaked that spread is. They answer different things: the probability says
which, the confidence says whether to act alone.

Route on confidence. Act when it is high. Ask a person, or gather more
evidence, when it is low. Pick the threshold from your own tolerance for a
wrong answer, then keep it in code where you can change it.

Treat a confident answer as evidence, not proof.

## Example: settle a tie

Request:

\`\`\`json
{
  "state": {
    "bug": "Checkout throws on an empty cart.",
    "fixes": {
      "guard": "Return early when the cart has no lines.",
      "schema": "Make the cart type reject an empty list.",
      "ui": "Hide the checkout button until a line exists."
    }
  },
  "questions": {
    "pick_fix": {
      "type": "choice",
      "instructions": "Which fix in \\\`fixes\\\` removes the cause of \\\`bug\\\` rather than hiding it?",
      "criteria": {
        "guard": "Adds a runtime check at the call site.",
        "schema": "Makes the broken state unrepresentable.",
        "ui": "Prevents the user from reaching the code path."
      }
    },
    "risky": {
      "type": "noul",
      "instructions": "Does the fix in \\\`fixes.schema\\\` change a public type other code depends on?",
      "criteria": {
        "true": "The fix changes a type that other code imports.",
        "false": "The fix stays inside this module."
      }
    }
  }
}
\`\`\`

Response:

\`\`\`json
{
  "model": "jev-1.13.0",
  "answers": {
    "pick_fix": {
      "type": "choice",
      "choice": "schema",
      "probabilities": { "guard": 0.21, "schema": 0.73, "ui": 0.06 },
      "confidence": 0.68
    },
    "risky": { "type": "noul", "noul": 0.82 }
  },
  "usage": { "input_tokens": 284, "output_tokens": 31 }
}
\`\`\`

Both answers came from one call. The second only mattered because the first
picked \`schema\`, and asking it up front cost 31 output tokens.

## Limits

- No generated text. Supply every candidate string yourself.
- No images.
- Every answer stays inside the options you listed.
- \`usage\` reports the tokens the API counted. Nothing is estimated.
`;
