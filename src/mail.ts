export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

export async function deliverMagicLink(env: Env, email: string, link: string): Promise<"logged" | "sent"> {
  if (!env.MAILCHANNELS_API_KEY || !env.MAIL_FROM) {
    console.log(`Magic link for ${email}: ${link}`);
    return "logged";
  }

  const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.MAILCHANNELS_API_KEY,
    },
    body: JSON.stringify({
      transactional: true,
      from: {
        email: env.MAIL_FROM,
        name: env.MAIL_FROM_NAME || "Small Circle Chat",
      },
      personalizations: [{ to: [{ email }] }],
      subject: "Your sign-in link",
      content: [
        {
          type: "text/plain",
          value: `Use this link to sign in. It expires in 15 minutes and works once.\n\n${link}\n`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("MailChannels send failed", response.status, detail);
    throw new MailDeliveryError("The email could not be sent.");
  }

  return "sent";
}
