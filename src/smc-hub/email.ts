//##############################################################################
//
//    CoCalc: Collaborative Calculation in the Cloud
//
//    Copyright (C) 2016 -- 2019, Sagemath Inc.
//
//    This program is free software: you can redistribute it and/or modify
//    it under the terms of the GNU General Public License as published by
//    the Free Software Foundation, either version 3 of the License, or
//    (at your option) any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU General Public License for more details.
//
//    You should have received a copy of the GNU General Public License
//    along with this program.  If not, see <http://www.gnu.org/licenses/>.
//
//##############################################################################

//########################################
// Sending emails
//########################################
// import { callback } from "awaiting";

const BANNED_DOMAINS = { "qq.com": true };

import { promisify } from "util";
import * as fs from "fs";
import * as os_path from "path";
const fs_readFile_prom = promisify(fs.readFile);
const async = require("async");
const winston = require("./winston-metrics").get_logger("email");
import { template } from "lodash";
import { ExtrasInterface } from "smc-util/db-schema/site-settings-extras";

// sendgrid API v3: https://sendgrid.com/docs/API_Reference/Web_API/mail.html
import * as sendgrid from "@sendgrid/client";

import * as nodemailer from "nodemailer";

const misc = require("smc-util/misc");
const { defaults, required } = misc;

import * as sanitizeHtml from "sanitize-html";
import { contains_url } from "smc-util-node/misc2_node";

const {
  SENDGRID_TEMPLATE_ID,
  SENDGRID_ASM_NEWSLETTER,
  COMPANY_NAME,
  COMPANY_EMAIL,
  DOMAIN_NAME,
  SITE_NAME,
  DNS,
  HELP_EMAIL,
  LIVE_DEMO_REQUEST
} = require("smc-util/theme");

export function escape_email_body(body: string, allow_urls: boolean): string {
  // in particular, no img and no anchor a
  const allowedTags: string[] = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "p",
    "ul",
    "ol",
    "nl",
    "li",
    "b",
    "i",
    "strong",
    "em",
    "strike",
    "code",
    "hr",
    "br",
    "div",
    "table",
    "thead",
    "caption",
    "tbody",
    "tr",
    "th",
    "td",
    "pre"
  ];
  if (allow_urls) {
    allowedTags.push("a");
  }
  return sanitizeHtml(body, { allowedTags });
}

// global state
let sendgrid_server: any | undefined = undefined;
let sendgrid_server_disabled = false;
let smtp_pw_reset_server: any | undefined = undefined;

async function init_sendgrid(dbg): Promise<void> {
  if (sendgrid_server != null) {
    return;
  }

  dbg("sendgrid not configured, starting...");
  const filename = `${process.env.SALVUS_ROOT}/data/secrets/sendgrid`;
  try {
    let api_key = await fs_readFile_prom(filename, "utf8");
    api_key = api_key.toString().trim();
    if (api_key.length === 0) {
      dbg(
        "sendgrid_server: explicitly disabled -- so pretend to always succeed for testing purposes"
      );
      sendgrid_server_disabled = true;
    } else {
      sendgrid.setApiKey(api_key);
      sendgrid_server = sendgrid;
      dbg("started sendgrid client");
    }
  } catch (err) {
    throw new Error(
      `unable to read the file '${filename}', which is needed to send emails -- ${err}`
    );
    dbg(err);
  }
}

async function send_via_sendgrid(opts, dbg) {
  dbg(`sending email to ${opts.to} starting...`);
  // Sendgrid V3 API -- https://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/index.html

  // no "to" field, that's in "personalizations!"
  const msg: any = {
    from: { email: opts.from, name: opts.fromname },
    subject: opts.subject,

    content: [
      {
        type: "text/html",
        value: opts.body
      }
    ],
    // plain template with a header (cocalc logo), a h1 title, and a footer
    template_id: SENDGRID_TEMPLATE_ID,

    personalizations: [
      {
        subject: opts.subject,
        to: [
          {
            email: opts.to
          }
        ]
      }
    ],

    // This #title# will end up below the header in an <h1> according to the template
    substitutions: {
      "#title#": opts.subject
    }
  };

  if (opts.replyto) {
    msg.reply_to = {
      name: opts.replyto_name ?? opts.replyto,
      email: opts.replyto
    };
  }

  if ((opts.cc != null ? opts.cc.length : undefined) > 0) {
    msg.cc = [{ email: opts.cc }];
  }
  if ((opts.bcc != null ? opts.bcc.length : undefined) > 0) {
    msg.bcc = [{ email: opts.bcc }];
  }

  // one or more strings to categorize the sent emails on sendgrid
  if (opts.category != null) {
    if (typeof opts.category == "string") {
      msg.categories = [opts.category];
    } else if (Array.isArray(opts.category)) {
      msg.categories = opts.category;
    }
  }

  // to unsubscribe only from a specific type of email, not everything!
  // https://app.sendgrid.com/suppressions/advanced_suppression_manager
  if (opts.asm_group != null) {
    msg.asm = { group_id: opts.asm_group };
  }

  dbg(`sending email to ${opts.to} -- data -- ${misc.to_json(msg)}`);

  const req = {
    body: msg,
    method: "POST",
    url: "/v3/mail/send"
  };

  return new Promise((done, fail) => {
    sendgrid_server
      .request(req)
      .then(([_, body]) => {
        dbg(`sending email to ${opts.to} -- success -- ${misc.to_json(body)}`);
        done();
      })
      .catch(err => {
        dbg(`sending email to ${opts.to} -- error = ${misc.to_json(err)}`);
        fail(err);
      });
  });
}

// constructs the email body, also containing sign up instructions pointing to a project.
// it might throw an error!
export function create_email_body(
  subject,
  body,
  email_address,
  project_title,
  link2proj,
  allow_urls_in_emails
): string {
  let direct_link: string;
  let base_url: string;
  if (link2proj != null) {
    const base_url_tokens = link2proj.split("/");
    base_url = `${base_url_tokens[0]}//${base_url_tokens[2]}`;
    direct_link = `Open <a href='${link2proj}'>the project '${project_title}'</a>.`;
  } else {
    // no link2proj provided -- at show something useful:
    direct_link = "";
    base_url = "https://cocalc.com";
  }

  let email_body = "";
  if (body) {
    email_body = escape_email_body(body, allow_urls_in_emails);
    // we check if there are plain URLs, which can be used to send SPAM
    if (!allow_urls_in_emails && contains_url(email_body)) {
      throw new Error("Sorry, links to specific websites are not allowed!");
    }
  } else {
    email_body = subject;
  }

  email_body += `
<br/><br/>
<b>To accept the invitation:
<ol>
<li>Open <a href="${base_url}/app">CoCalc</a></li>
<li>Sign up/in using <i>exactly</i> your email address <code>${email_address}</code></li>
<li>${direct_link}</li>
</ol></b>
<br/><br />
(If you're already signed in via <i>another</i> email address,
 you have to sign out and sign up/in using the mentioned email address.)
`;

  return email_body;
}

export function is_banned(address): boolean {
  const i = address.indexOf("@");
  if (i === -1) {
    return false;
  }
  const x = address.slice(i + 1).toLowerCase();
  return !!BANNED_DOMAINS[x];
}

function make_dbg(opts) {
  if (opts.verbose) {
    return m => winston.debug(`send_email(to:${opts.to}) -- ${m}`);
  } else {
    return function(_) {};
  }
}

async function init_pw_reset_smtp_server(opts): Promise<void> {
  const s = opts.settings;
  if (smtp_pw_reset_server != null && s.password_reset_override == "smtp") {
    return;
  }

  // s.password_reset_smpt_from;
  smtp_pw_reset_server = await nodemailer.createTransport({
    host: s.password_reset_smpt_server,
    port: s.password_reset_smpt_port,
    secure: s.password_reset_smpt_secure, // true for 465, false for other ports
    auth: {
      user: s.password_reset_smpt_login,
      pass: s.password_reset_smpt_password
    }
  });
}

// construct the actual HTML body of a password reset email sent via SMTP
// in particular, all emails must have a body explaining who sent it!
const pw_reset_body_tmpl = template(`
<h1>RESET EMAIL</h1>

<%= body %>

<p style="margin-top: 30px, font-size: 80%, text-align: center">
Footer <%= fromname %> <%= from %>
</p>
`);

function password_reset_body(opts: Opts): string {
  return pw_reset_body_tmpl(opts);
}

interface Opts {
  subject: string;
  body: string;
  fromname?: string;
  from?: string;
  to: string;
  replyto?: string;
  replyto_name?: string;
  cc?: string;
  bcc?: string;
  verbose?: boolean;
  category?: string;
  asm_group?: number;
  // "Partial" b/c any might be missing for random reasons
  settings: Partial<{ [key in keyof ExtrasInterface]: string }>;
  cb?: (err?, msg?) => void;
}

const opts_default: Opts = {
  subject: required,
  body: required,
  fromname: COMPANY_NAME,
  from: COMPANY_EMAIL,
  to: required,
  replyto: undefined,
  replyto_name: undefined,
  cc: "",
  bcc: "",
  verbose: true,
  cb: undefined,
  category: undefined,
  asm_group: undefined,
  settings: {}
};

// here's how I test this function:
//    require('email').send_email(subject:'TEST MESSAGE', body:'body', to:'wstein@sagemath.com', cb:console.log)
export async function send_email(opts: Opts): Promise<void> {
  opts = defaults(opts, opts_default);

  const dbg = make_dbg(opts);
  dbg(`${opts.body.slice(0, 201)}...`);

  if (is_banned(opts.to) || is_banned(opts.from)) {
    dbg("WARNING: attempt to send banned email");
    if (typeof opts.cb === "function") {
      opts.cb("banned domain");
    }
    return;
  }

  let disabled = false;
  let message: string | undefined = undefined;
  const pw_reset_smtp =
    opts.category == "password_reset" &&
    opts.settings.password_reset_override == "smtp";

  try {
    await init_sendgrid(dbg);
    // if not available for any reason …
    if (sendgrid_server == null || sendgrid_server_disabled) {
      disabled = true;
    }

    // this is a password reset email, and we send it via smtp
    if (pw_reset_smtp) {
      dbg("initializing PW SMTP server...");
      await init_pw_reset_smtp_server(opts);

      //const ts = new Date().toISOString();
      dbg("sending PW reset via SMTP server ...");
      const info = await smtp_pw_reset_server.sendMail({
        from: opts.settings.password_reset_smpt_from,
        replyTo: opts.settings.password_reset_smpt_from,
        to: opts.to,
        subject: opts.subject,
        html: password_reset_body(opts)
      });

      message = `password reset email sent via SMTP: ${info.messageId}`;
      dbg(message);
    } else {
      if (disabled) {
        message = "sendgrid email disabled -- no actual message sent";
        dbg(message);
      } else {
        await send_via_sendgrid(opts, dbg);
      }
    }

    // all fine, no errors
    typeof opts.cb === "function" ? opts.cb(undefined, message) : undefined;
  } catch (err) {
    if (err) {
      // so next time it will try fresh to connect to email server, rather than being wrecked forever.
      sendgrid_server = undefined;
      err = `error sending email -- ${misc.to_json(err)}`;
      dbg(err);
    } else {
      dbg("successfully sent email");
    }
    typeof opts.cb === "function" ? opts.cb(err, message) : undefined;
  }
}

// Send a mass email to every address in a file.
// E.g., put the email addresses in a file named 'a' and
//    require('email').mass_email(subject:'TEST MESSAGE', body:'body', to:'a', cb:console.log)
export function mass_email(opts): void {
  opts = defaults(opts, {
    subject: required,
    body: required,
    from: COMPANY_EMAIL,
    fromname: COMPANY_NAME,
    to: required, // array or string (if string, opens and reads from file, splitting on whitspace)
    cc: "",
    limit: 10, // number to send in parallel
    cb: undefined
  }); // cb(err, list of recipients that we succeeded in sending email to)

  const dbg = m => winston.debug(`mass_email: ${m}`);
  dbg(opts.filename);
  dbg(opts.subject);
  dbg(opts.body);
  const success: string[] = [];
  const recipients: string[] = [];

  return async.series(
    [
      function(cb): void {
        if (typeof opts.to !== "string") {
          recipients.push(opts.to);
          cb();
        } else {
          fs.readFile(opts.to, function(err, data): void {
            if (err) {
              cb(err);
            } else {
              recipients.push(...misc.split(data.toString()));
              cb();
            }
          });
        }
      },
      function(cb): void {
        let n = 0;
        const f = function(to, cb) {
          if (n % 100 === 0) {
            dbg(`${n}/${recipients.length - 1}`);
          }
          n += 1;
          send_email({
            subject: opts.subject,
            body: opts.body,
            from: opts.from,
            fromname: opts.fromname,
            to,
            cc: opts.cc,
            asm_group: SENDGRID_ASM_NEWSLETTER,
            category: "newsletter",
            verbose: false,
            settings: {}, // TODO: fill in the real settings
            cb(err): void {
              if (!err) {
                success.push(to);
                cb();
              } else {
                cb(`error sending email to ${to} -- ${err}`);
              }
            }
          });
        };

        async.mapLimit(recipients, opts.limit, f, cb);
      }
    ],
    err => (typeof opts.cb === "function" ? opts.cb(err, success) : undefined)
  );
}

function verify_email_html(token_url) {
  return `
<p style="margin-top:0;margin-bottom:10px;">
<strong>
Please <a href="${token_url}">click here</a> to verify your email address!
If this link does not work, please copy/paste this URL into a new browser tab and open the link:
</strong>
</p>

<pre style="margin-top:10px;margin-bottom:10px;font-size:11px;">
${token_url}
</pre>
`;
}

// beware, this needs to be HTML which is compatible with email-clients!
function welcome_email_html(token_url) {
  return `\
<h1>Welcome to ${SITE_NAME}</h1>

<p style="margin-top:0;margin-bottom:10px;">
<a href="${DOMAIN_NAME}">${SITE_NAME}</a> helps you do collaborative
calculations in your web browser.
</p>

<p style="margin-top:0;margin-bottom:20px;">
You received this email because an account with your email address was created.
This was either initiated by you, a friend or colleague invited you, or you're
a student as part of a course.
</p>

${verify_email_html(token_url)}

<hr size="1"/>

<h3>Exploring ${SITE_NAME}</h3>
<p style="margin-top:0;margin-bottom:10px;">
In ${SITE_NAME} your work happens inside <strong>private projects</strong>.
These are personal workspaces which contain your files, computational worksheets, and data.
You can run your computations through the web interface, via interactive worksheets and notebooks, or by executing a program in a terminal.
${SITE_NAME} supports online editing of
    <a href="https://jupyter.org/">Jupyter Notebooks</a>,
    <a href="https://www.sagemath.org/">Sage Worksheets</a>,
    <a href="https://en.wikibooks.org/wiki/LaTeX">Latex files</a>, etc.
</p>

<p><strong>Software:</strong>
<ul>
<li style="margin-top:0;margin-bottom:10px;">Mathematical calculation:
    <a href="https://www.sagemath.org/">SageMath</a>,
    <a href="https://www.sympy.org/">SymPy</a>, etc.
</li>
<li style="margin-top:0;margin-bottom:10px;">Statistics and Data Science:
    <a href="https://www.r-project.org/">R project</a>,
    <a href="http://pandas.pydata.org/">Pandas</a>,
    <a href="http://www.statsmodels.org/">statsmodels</a>,
    <a href="http://scikit-learn.org/">scikit-learn</a>,
    <a href="http://www.nltk.org/">NLTK</a>, etc.
</li>
<li style="margin-top:0;margin-bottom:10px;">Various other computation:
    <a href="https://www.tensorflow.org/">Tensorflow</a>,
    <a href="https://www.gnu.org/software/octave/">Octave</a>,
    <a href="https://julialang.org/">Julia</a>, etc.
</li>
</ul>

<p style="margin-top:0;margin-bottom:20px;">
Visit our <a href="https://cocalc.com/static/doc/software.html">Software overview page</a> for more details!
</p>

<p style="margin-top:0;margin-bottom:20px;">
<strong>Collaboration:</strong>
You can invite collaborators to work with you inside a project.
Like you, they can edit the files in that project.
Edits are visible in <strong>real time</strong> for everyone online.
You can share your thoughts in a <strong>side chat</strong> next to each document.
</p>

<p style="margin-top:0;margin-bottom:10px;"><strong>More information:</strong> how to get from 0 to 100%!</p>

<ul>
<li style="margin-top:0;margin-bottom:10px;">
    <strong><a href="https://doc.cocalc.com/">${SITE_NAME} Manual:</a></strong> learn more about ${SITE_NAME}'s features.
</li>
<li style="margin-top:0;margin-bottom:10px;">
    <a href="https://doc.cocalc.com/sagews.html">Working with SageMath Worksheets</a>
</li>
<li style="margin-top:0;margin-bottom:10px;">
    <strong><a href="https://cocalc.com/policies/pricing.html">Subscriptions:</a></strong> make hosting more robust and increase project quotas
</li>
<li style="margin-top:0;margin-bottom:10px;">
    <a href="https://doc.cocalc.com/teaching-instructors.html">Sophisticated tools for teaching a class</a>.
</li>
<li style="margin-top:0;margin-bottom:10px;">
    <a href="https://doc.cocalc.com/howto/connectivity-issues.html">Troubleshooting connectivity issues</a>
</li>
<li style="margin-top:0;margin-bottom:10px;">
    <a href="https://github.com/sagemathinc/cocalc/wiki/MathematicalSyntaxErrors">Common mathematical syntax errors:</a> look into this if you are new to working with a programming language!
</li>
</ul>

<p style="margin-top:20px;margin-bottom:10px;">
<strong>Questions?</strong>
</p>
<p style="margin-top:0;margin-bottom:10px;">
Schedule a Live Demo with a specialist from CoCalc: <a href="${LIVE_DEMO_REQUEST}">request form</a>.
</p>
<p style="margin-top:0;margin-bottom:20px;">
In case of problems, concerns why you received this email, or other questions please contact:
<a href="mailto:${HELP_EMAIL}">${HELP_EMAIL}</a>.
</p>
\
`;
}

export function welcome_email(opts): void {
  let body, category, subject;
  opts = defaults(opts, {
    to: required,
    token: required, // the email verification token
    only_verify: false, // TODO only send the verification token, for now this is good enough
    settings: {},
    cb: undefined
  });

  const base_url = require("./base-url").base_url();
  const token_query = encodeURI(
    `email=${encodeURIComponent(opts.to)}&token=${opts.token}`
  );
  const endpoint = os_path.join("/", base_url, "auth", "verify");
  const token_url = `${DOMAIN_NAME}${endpoint}?${token_query}`;

  if (opts.only_verify) {
    subject = `Verify your email address on ${SITE_NAME} (${DNS})`;
    body = verify_email_html(token_url);
    category = "verify";
  } else {
    subject = `Welcome to ${SITE_NAME} - ${DNS}`;
    body = welcome_email_html(token_url);
    category = "welcome";
  }

  send_email({
    subject,
    body,
    fromname: COMPANY_NAME,
    from: COMPANY_EMAIL,
    to: opts.to,
    cb: opts.cb,
    category,
    settings: opts.settings,
    asm_group: 147985
  }); // https://app.sendgrid.com/suppressions/advanced_suppression_manager
}

export function email_verified_successfully(url): string {
  const title = `${SITE_NAME}: Email verification successful`;

  return `<DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="5;url=${url}" />
<style>
* {font-family: sans-serif;}
</style>
  <title>${title}</title>
</head>
<body>
<h1>Email verification successful!</h1>
<div>
Click <a href="${url}">here</a> if you aren't automatically redirected to <a href="${url}">${SITE_NAME}</a>.
</div>
</body>
</html>
`;
}

export function email_verification_problem(url, problem): string {
  const title = `${SITE_NAME}: Email verification problem`;

  return `<DOCTYPE html>
<html>
<head>
<style>
div, p, h1, h2 {font-family: sans-serif;}
div {margin-top: 1rem;}
</style>
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <div>There was a problem verifying your email address.</div>
  <div>Reason: <code>${problem}</code></div>
  <div>
    Continue to <a href="${url}">${SITE_NAME}</a> or
    contact support: <a href="mailto:${HELP_EMAIL}">${HELP_EMAIL}</a>.
  </div>
</body>
</html>
  `;
}
