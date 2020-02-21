//##############################################################################
//
//    CoCalc: Collaborative Calculation in the Cloud
//
//    Copyright (C) 2016, Sagemath Inc.
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

/*
The schema below determines the PostgreSQL database schema.   The notation is as follows:

schema.table_name =
    desc: 'A description of this table.'   # will be used only for tooling
    primary_key : 'the_table_primary_key'
    durability :  'hard' or 'soft' # optional -- if given, specify the table durability; 'hard' is the default
    fields :   # every field *must* be listed here or user queries won't work.
        the_table_primary_key :
            type : 'uuid'
            desc : 'This is the primary key of the table.'
        ...
    pg_indexes : [array of column names]  # also some more complicated ways to define indexes; see the examples.
    user_query :  # queries that are directly exposed to the client via a friendly "fill in what result looks like" query language
        get :     # describes get query for reading data from this table
            pg_where :  # this gets run first on the table before
                      'account_id' - replaced by user's account_id
                      'project_id' - filled in by project_id, which must be specified in the query itself;
                                    (if table not anonymous then project_id must be a project that user has read access to)
                      'project_id-public' - filled in by project_id, which must be specified in the query itself;
                                    (if table not anonymous then project_id must be of a project with at east one public path)
                      'all_projects_read' - filled in with list of all the id's of projects this user has read access to
                      'collaborators' - filled in by account_id's of all collaborators of this user
                      an arbitrary function -  gets called with an object with these keys:
                             account_id, table, query, multi, options, changes
            fields :  # these are the fields any user is allowed to see, subject to the all constraint above
                field_name    : either null or a default_value
                another_field : 10   # means will default to 10 if undefined in database
                this_field    : null # no default filled in
                settings :
                     strip : false   # defaults for a field that is an object -- these get filled in if missing in db
                     wrap  : true
        set :     # describes more dangerous *set* queries that the user can make via the query language
            pg_where :   # initially restrict what user can set
                'account_id' - user account_id
                      - list of project_id's that the user has write access to
            fields :    # user must always give the primary key in set queries
                account_id : 'account_id'  # means that this field will automatically be filled in with account_id
                project_id : 'project_write' # means that this field *must* be a project_id that the user has *write* access to
                foo : true   # user is allowed (but not required) to set this
                bar : true   # means user is allowed to set this

To specify more than one user query against a table, make a new table as above, omitting
everything except the user_query section, and include a virtual section listing the actual
table to query:

    virtual : 'original_table'

For example,

schema.collaborators =
    primary_key : 'account_id'
    anonymous   : false
    virtual     : 'accounts'
    user_query:
        get : ...


Finally, putting

    anonymous : true

makes it so non-signed-in-users may query the table (read only) for data, e.g.,

schema.stats =
    primary_key: 'id'
    anonymous : true   # allow user access, even if not signed in
    fields:
        id                  : true
        ...

*/
const misc = require("../misc");

const { DEFAULT_QUOTAS } = require("../upgrade-spec");

import { DEFAULT_COMPUTE_IMAGE } from "./defaults";
import { site_settings_conf } from "./site-defaults";
import { EXTRAS as site_settings_extras } from "./site-settings-extras";

export const schema: any = {};

schema.account_profiles = {
  desc:
    "(Virtual) Table that provides access to the profiles of all users; the profile is their *publicly visible* avatar.",
  virtual: "accounts",
  anonymous: false,
  user_query: {
    get: {
      pg_where: [],
      options: [{ limit: 1 }], // in case user queries for [{account_id:null, profile:null}] they should not get the whole database.
      fields: {
        account_id: null,
        profile: {
          image: undefined,
          color: undefined
        }
      }
    }
  }
};

schema.blobs = {
  desc:
    "Table that stores blobs mainly generated as output of Sage worksheets.",
  primary_key: "id",
  fields: {
    id: {
      type: "uuid",
      desc:
        "The uuid of this blob, which is a uuid derived from the Sha1 hash of the blob content."
    },
    blob: {
      type: "Buffer",
      desc: "The actual blob content"
    },
    expire: {
      type: "timestamp",
      desc:
        "When to expire this blob (when delete_expired is called on the database)."
    },
    created: {
      type: "timestamp",
      desc: "When the blob was created."
    },
    project_id: {
      type: "string",
      desc: "The uuid of the project that created the blob."
    },
    last_active: {
      type: "timestamp",
      desc: "When the blob was last pulled from the database."
    },
    count: {
      type: "number",
      desc: "How many times the blob has been pulled from the database."
    },
    size: {
      type: "number",
      desc: "The size in bytes of the blob."
    },
    gcloud: {
      type: "string",
      desc: "name of a bucket that contains the actual blob, if available."
    },
    backup: {
      type: "boolean",
      desc: "if true, then this blob was saved to an offsite backup"
    },
    compress: {
      type: "string",
      desc: "optional compression used: 'gzip', 'zlib', 'snappy'"
    }
  },
  user_query: {
    get: {
      async instead_of_query(database, opts, cb): Promise<void> {
        const obj: any = Object.assign({}, opts.query);
        if (obj == null || obj.id == null) {
          cb("id must be specified");
          return;
        }
        database.get_blob({
          uuid: obj.id,
          cb(err, blob) {
            if (err) {
              cb(err);
            } else {
              cb(undefined, { id: obj.id, blob });
            }
          }
        });
      },
      fields: {
        id: null,
        blob: null
      }
    },
    set: {
      fields: {
        id: true,
        blob: true,
        project_id: "project_write",
        ttl: 0
      },
      required_fields: {
        id: true,
        blob: true,
        project_id: true
      },
      async instead_of_change(
        database,
        _old_value,
        new_val,
        _account_id,
        cb
      ): Promise<void> {
        database.save_blob({
          uuid: new_val.id,
          blob: new_val.blob,
          ttl: new_val.ttl,
          project_id: new_val.project_id,
          check: true, // can't trust the user!
          cb
        });
      }
    }
  }
};

schema.client_error_log = {
  primary_key: "id",
  durability: "soft", // loss of some log data not serious, since used only for analytics
  fields: {
    id: {
      type: "uuid"
    },
    event: {
      type: "string"
    },
    error: {
      type: "string"
    },
    account_id: {
      type: "uuid"
    },
    time: {
      type: "timestamp"
    }
  },
  pg_indexes: ["time", "event"]
};

schema.webapp_errors = {
  primary_key: "id",
  durability: "soft", // loss of some log data not serious, since used only for analytics
  fields: {
    id: { type: "uuid" },
    account_id: { type: "uuid" },
    name: { type: "string" },
    message: { type: "string" },
    comment: { type: "string" },
    stacktrace: { type: "string" },
    file: { type: "string" },
    lineNumber: { type: "integer" },
    columnNumber: { type: "integer" },
    severity: { type: "string" },
    browser: { type: "string" },
    mobile: { type: "boolean" },
    responsive: { type: "boolean" },
    user_agent: { type: "string" },
    path: { type: "text" },
    smc_version: { type: "string" },
    build_date: { type: "string" },
    smc_git_rev: { type: "string" },
    uptime: { type: "string" },
    start_time: { type: "timestamp" },
    time: { type: "timestamp" }
  },
  pg_indexes: [
    "time",
    "name",
    "account_id",
    "smc_git_rev",
    "smc_version",
    "start_time",
    "browser"
  ]
};

schema.collaborators = {
  primary_key: "account_id",
  db_standby: "unsafe",
  anonymous: false,
  virtual: "accounts",
  fields: {
    account_id: true,
    first_name: true,
    last_name: true,
    last_active: true,
    profile: true
  },
  user_query: {
    get: {
      pg_where: [
        {
          "account_id = ANY(SELECT DISTINCT jsonb_object_keys(users)::UUID FROM projects WHERE users ? $::TEXT)":
            "account_id"
        }
      ],
      pg_changefeed: "collaborators",
      fields: {
        account_id: null,
        first_name: "",
        last_name: "",
        last_active: null,
        profile: null
      }
    }
  }
};

// This table does NOT support changefeeds.
schema.collaborators_one_project = {
  primary_key: "account_id",
  db_standby: "unsafe",
  anonymous: false,
  virtual: "accounts",
  fields: {
    account_id: true,
    project_id: true,
    first_name: true,
    last_name: true,
    last_active: true,
    profile: true
  },
  user_query: {
    get: {
      pg_where: [
        {
          "account_id = ANY(SELECT DISTINCT jsonb_object_keys(users)::UUID FROM projects WHERE project_id = $::UUID)":
            "project_id"
        }
      ],
      remove_from_query: [
        "project_id"
      ] /* this is only used for the pg_where and removed from the actual query */,
      fields: {
        account_id: null,
        project_id: null,
        first_name: "",
        last_name: "",
        last_active: null,
        profile: null
      }
    }
  }
};

schema.compute_servers = {
  primary_key: "host",
  fields: {
    host: {
      type: "string",
      pg_type: "VARCHAR(63)"
    },
    dc: {
      type: "string"
    },
    port: {
      type: "integer"
    },
    secret: {
      type: "string"
    },
    experimental: {
      type: "boolean"
    },
    member_host: {
      type: "boolean"
    },
    status: {
      type: "map",
      desc: "something like {stuff:?,...,timestamp:?}",
      date: ["timestamp"]
    }
  }
};

schema.file_access_log = {
  primary_key: "id",
  durability: "soft", // loss of some log data not serious, since used only for analytics
  fields: {
    id: {
      type: "uuid"
    },
    project_id: {
      type: "uuid"
    },
    account_id: {
      type: "uuid"
    },
    filename: {
      type: "string"
    },
    time: {
      type: "timestamp"
    }
  },
  pg_indexes: ["project_id", "account_id", "filename", "time"]
};

// This table is derived from file_access_log.  It's the image of the set file_access_log under
// the non-injective function
//
//    (id,project_id,account_id,filename,time) |--> (project_id, account_id, date),
//
// where date is the day of the time. For reference, this query computes/update this table:
//
//   insert into usage_by_date (account_id, project_id, date) (select distinct account_id, project_id, time::date from file_access_log) ON CONFLICT DO NOTHING;
//
schema.usage_by_date = {
  primary_key: ["date", "account_id", "project_id"],
  durability: "soft", // loss of some log data not serious, since used only for analytics
  fields: {
    project_id: {
      type: "uuid"
    },
    account_id: {
      type: "uuid"
    },
    date: {
      type: "date"
    }
  },
  pg_indexes: ["date", "account_id", "project_id"]
};

// TODO: for postgres rewrite after done we MIGHT completely redo file_use to eliminate
// the id field, use project_id, path as a compound primary key, and maybe put users in
// another table with a relation.  There is also expert discussion about this table in the
// Hacker News discussion of my PostgreSQL vs ... blog post.
schema.file_use = {
  primary_key: "id",
  durability: "soft", // loss of some log data not serious, since used only for showing notifications
  unique_writes: true, // there is no reason for a user to write the same record twice
  db_standby: "safer", // allow doing the initial read part of the query from a standby node.
  fields: {
    id: {
      type: "string",
      pg_type: "CHAR(40)"
    },
    project_id: {
      type: "uuid"
    },
    path: {
      type: "string"
    },
    users: {
      type: "map",
      desc:
        "{account_id1: {action1: timestamp1, action2:timestamp2}, account_id2: {...}}",
      date: "all"
    },
    last_edited: {
      type: "timestamp"
    }
  },

  pg_indexes: ["project_id", "last_edited"],

  // I put a time limit in pg_where below of to just give genuinely recent notifications,
  // and massively reduce server load.  The obvious todo list is to make another file_use
  // virtual table that lets you get older entries.
  user_query: {
    get: {
      pg_where: ["last_edited >= NOW() - interval '21 days'", "projects"],
      pg_changefeed: "projects",
      options: [{ order_by: "-last_edited" }, { limit: 200 }], // limit is arbitrary
      throttle_changes: 3000,
      fields: {
        id: null,
        project_id: null,
        path: null,
        users: null,
        last_edited: null
      }
    },
    set: {
      fields: {
        id(obj, db) {
          return db.sha1(obj.project_id, obj.path);
        },
        project_id: "project_write",
        path: true,
        users: true,
        last_edited: true
      },
      required_fields: {
        id: true,
        project_id: true,
        path: true
      },
      check_hook(db, obj, account_id, _project_id, cb) {
        // hook to note that project is being used (CRITICAL: do not pass path
        // into db.touch since that would cause another write to the file_use table!)
        // CRITICAL: Only do this if what edit or chat for this user is very recent.
        // Otherwise we touch the project just for seeing notifications or opening
        // the file, which is confusing and wastes a lot of resources.
        const x = obj.users != null ? obj.users[account_id] : undefined;
        const recent = misc.minutes_ago(3);
        if (
          x != null &&
          (x.edit >= recent || x.chat >= recent || x.open >= recent)
        ) {
          db.touch({ project_id: obj.project_id, account_id });
          // Also log that this particular file is being used/accessed; this
          // is mainly only for longterm analytics but also the file_use_times
          // virtual table queries this.  Note that log_file_access
          // is throttled.
          db.log_file_access({
            project_id: obj.project_id,
            account_id,
            filename: obj.path
          });
        }
        cb();
      }
    }
  }
};

schema.hub_servers = {
  primary_key: "host",
  durability: "soft", // loss of some log data not serious, since ephemeral and expires quickly anyways
  fields: {
    host: {
      type: "string",
      pg_type: "VARCHAR(63)"
    },
    port: {
      type: "integer"
    },
    clients: {
      type: "integer"
    },
    expire: {
      type: "timestamp"
    }
  }
};

schema.instances = {
  primary_key: "name",
  fields: {
    name: {
      type: "string"
    },
    gce: {
      type: "map"
    },
    gce_sha1: {
      type: "string"
    },
    requested_preemptible: {
      type: "boolean"
    },
    requested_status: {
      type: "string",
      desc: "One of 'RUNNING', 'TERMINATED'"
    },
    action: {
      type: "map",
      desc:
        "{action:'start', started:timestamp, finished:timestamp,  params:?, error:?, rule:?}",
      date: ["started", "finished"]
    }
  }
};

schema.instance_actions_log = {
  primary_key: "id",
  fields: {
    id: {
      type: "uuid"
    },
    name: {
      type: "string",
      desc: "hostname of vm",
      pg_type: "VARCHAR(63)"
    },
    action: {
      type: "map",
      desc: "same as finished action object for instances above",
      date: ["started", "finished"]
    }
  }
};

schema.passport_settings = {
  primary_key: "strategy",
  fields: {
    strategy: {
      type: "string"
    },
    conf: {
      type: "map"
    }
  }
};

schema.password_reset = {
  primary_key: "id",
  fields: {
    id: {
      type: "uuid"
    },
    email_address: {
      type: "string"
    },
    expire: {
      type: "timestamp"
    }
  }
};

schema.password_reset_attempts = {
  primary_key: "id",
  durability: "soft", // loss not serious, since used only for analytics and preventing attacks
  fields: {
    id: {
      type: "uuid"
    },
    email_address: {
      type: "string"
    },
    ip_address: {
      type: "string",
      pg_type: "inet"
    },
    time: {
      type: "timestamp"
    }
  },
  pg_indexes: ["time"]
};

schema.project_log = {
  primary_key: "id",
  // db_standby feels too slow for this, since the user only
  // does this query when they actually click to show the log.
  //db_standby: "unsafe",
  durability: "soft", // dropping a log entry (e.g., "foo opened a file") wouldn't matter much
  fields: {
    id: {
      type: "uuid",
      desc: "which"
    },
    project_id: {
      type: "uuid",
      desc: "where"
    },
    time: {
      type: "timestamp",
      desc: "when"
    },
    account_id: {
      type: "uuid",
      desc: "who"
    },
    event: {
      type: "map",
      desc: "what"
    }
  },

  pg_indexes: ["project_id", "time"],

  user_query: {
    get: {
      pg_where: ["time >= NOW() - interval '2 months'", "projects"],
      pg_changefeed: "projects",
      options: [{ order_by: "-time" }, { limit: 300 }],
      throttle_changes: 2000,
      fields: {
        id: null,
        project_id: null,
        time: null,
        account_id: null,
        event: null
      }
    },
    set: {
      fields: {
        id(obj) {
          return obj.id != null ? obj.id : misc.uuid();
        },
        project_id: "project_write",
        account_id: "account_id",
        time: true,
        event: true
      }
    }
  }
};

// project_log_all -- exactly like project_log, but loads up
// to the most recent **many** log entries (so a LOT).
schema.project_log_all = misc.deep_copy(schema.project_log);
// This happens rarely, and user is prepared to wait.
schema.project_log_all.db_standby = "unsafe";
schema.project_log_all.virtual = "project_log";
// no time constraint:
schema.project_log_all.user_query.get.pg_where = ["projects"];
schema.project_log_all.user_query.get.options = [
  { order_by: "-time" },
  { limit: 7500 }
];

schema.projects = {
  primary_key: "project_id",
  //# A lot depends on this being right at all times, e.g., restart state,
  //# so do not use db_standby yet.
  //# It is simply not robust enough.
  //# db_standby : 'safer'
  fields: {
    project_id: {
      type: "uuid",
      desc:
        "The project id, which is the primary key that determines the project."
    },
    title: {
      type: "string",
      desc:
        "The short title of the project. Should use no special formatting, except hashtags."
    },
    description: {
      type: "string",
      desc:
        "A longer textual description of the project.  This can include hashtags and should be formatted using markdown."
    }, // markdown rendering possibly not implemented
    users: {
      type: "map",
      desc:
        "This is a map from account_id's to {hide:bool, group:['owner',...], upgrades:{memory:1000, ...}, ssh:{...}}."
    },
    invite: {
      type: "map",
      desc:
        "Map from email addresses to {time:when invite sent, error:error message if there was one}",
      date: ["time"]
    },
    invite_requests: {
      type: "map",
      desc:
        "This is a map from account_id's to {timestamp:?, message:'i want to join because...'}.",
      date: ["timestamp"]
    },
    deleted: {
      type: "boolean",
      desc: "Whether or not this project is deleted."
    },
    host: {
      type: "map",
      desc:
        "This is a map {host:'hostname_of_server', assigned:timestamp of when assigned to that server}.",
      date: ["assigned"]
    },
    settings: {
      type: "map",
      desc:
        'This is a map that defines the free base quotas that a project has. It is of the form {cores: 1.5, cpu_shares: 768, disk_quota: 1000, memory: 2000, mintime: 36000000, network: 0, ephemeral_state:0, ephemeral_disk:0}.  WARNING: some of the values are strings not numbers in the database right now, e.g., disk_quota:"1000".'
    },
    site_license: {
      type: "map",
      desc:
        "This is a map that defines upgrades (just when running the project) that come from a site license, and also the licenses that are applied to this project.  The format is {licensed_id:{memory:?, mintime:?, ...}} where the target of the license_id is the same as for the settings field. The licensed_id is the uuid of the license that contributed these upgrades.  To tell cocalc to use a license for a project, a user sets site_license to {license_id:{}}, and when it is requested to start the project, the backend decides what allocation license_id provides and changes the field accordingly."
    },
    status: {
      type: "map",
      desc:
        'This is a map computed by the status command run inside a project, and slightly enhanced by the compute server, which gives extensive status information about a project.  It has the form {console_server.pid: [pid of the console server, if running], console_server.port: [port if it is serving], disk_MB: [MB of used disk], installed: [whether code is installed], local_hub.pid: [pid of local hub server process],  local_hub.port: [port of local hub process], memory: {count:?, pss:?, rss:?, swap:?, uss:?} [output by smem],  raw.port: [port that the raw server is serving on], sage_server.pid: [pid of sage server process], sage_server.port: [port of the sage server], secret_token: [long random secret token that is needed to communicate with local_hub], state: "running" [see COMPUTE_STATES in the compute-states file], version: [version number of local_hub code]}'
    },
    state: {
      type: "map",
      desc:
        'Info about the state of this project of the form  {error: "", state: "running", time: timestamp}, where time is when the state was last computed.  See COMPUTE_STATES in the compute-states file.',
      date: ["time"]
    },
    last_edited: {
      type: "timestamp",
      desc:
        "The last time some file was edited in this project.  This is the last time that the file_use table was updated for this project."
    },
    last_started: {
      type: "timestamp",
      desc: "The last time the project started running."
    },
    last_active: {
      type: "map",
      desc:
        "Map from account_id's to the timestamp of when the user with that account_id touched this project.",
      date: "all"
    },
    created: {
      type: "timestamp",
      desc: "When the project was created."
    },
    action_request: {
      type: "map",
      desc:
        "Request state change action for project: {action:['restart', 'stop', 'save', 'close'], started:timestamp, err:?, finished:timestamp}",
      date: ["started", "finished"]
    },
    storage: {
      type: "map",
      desc:
        "This is a map {host:'hostname_of_server', assigned:when first saved here, saved:when last saved here}.",
      date: ["assigned", "saved"]
    },
    last_backup: {
      type: "timestamp",
      desc:
        "(DEPRECATED) Timestamp of last off-disk successful backup using bup to Google cloud storage"
    },
    storage_request: {
      type: "map",
      desc:
        "(DEPRECATED) {action:['save', 'close', 'move', 'open'], requested:timestap, pid:?, target:?, started:timestamp, finished:timestamp, err:?}",
      date: ["started", "finished", "requested"]
    },
    course: {
      type: "map",
      desc:
        "{project_id:[id of project that contains .course file], path:[path to .course file], pay:?, email_address:[optional email address of student -- used if account_id not known], account_id:[account id of student]}, where pay is either not set (or equals falseish) or is a timestamp by which the students must move the project to a members only server.",
      date: ["pay"]
    },
    storage_server: {
      type: "integer",
      desc:
        "(DEPRECATED) Number of the Kubernetes storage server with the data for this project: one of 0, 1, 2, ..."
    },
    storage_ready: {
      type: "boolean",
      desc:
        "(DEPRECATED) Whether storage is ready to be used on the storage server.  Do NOT try to start project until true; this gets set by storage daemon when it notices that run is true."
    },
    disk_size: {
      type: "integer",
      desc: "Size in megabytes of the project disk."
    },
    resources: {
      type: "map",
      desc:
        'Object of the form {requests:{memory:"30Mi",cpu:"5m"}, limits:{memory:"100Mi",cpu:"300m"}} which is passed to the k8s resources section for this pod.'
    },
    preemptible: {
      type: "boolean",
      desc: "If true, allow to run on preemptible nodes."
    },
    idle_timeout: {
      type: "integer",
      desc:
        "If given and nonzero, project will be killed if it is idle for this many **minutes**, where idle *means* that last_edited has not been updated."
    },
    run_quota: {
      type: "map",
      desc: "If project is running, this is the quota that it is running with."
    },
    compute_image: {
      type: "string",
      desc: `Specify the name of the underlying (kucalc) compute image (default: '${DEFAULT_COMPUTE_IMAGE}')`
    },
    addons: {
      type: "map",
      desc:
        "Configure (kucalc specific) addons for projects. (e.g. academic software, license keys, ...)"
    },
    lti_id: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "This is a specific ID derived from an LTI context"
    },
    lti_data: {
      type: "map",
      desc: "extra information related to LTI"
    }
  },

  pg_indexes: [
    "last_edited",
    "USING GIN (users)", // so get_collaborator_ids is fast
    "USING GIN (host jsonb_path_ops)", // so get_projects_on_compute_server is fast
    "lti_id",
    "USING GIN (state)" // so getting all running projects is fast (e.g. for site_license_usage_log... but also manage-state)
  ],

  user_query: {
    get: {
      // if you change the interval, change the text in projects.cjsx
      pg_where: ["last_edited >= NOW() - interval '10 days'", "projects"],
      options: [{ limit: 20, order_by: "-last_edited" }],
      pg_changefeed: "projects",
      throttle_changes: 2000,
      fields: {
        project_id: null,
        title: "",
        description: "",
        users: {},
        invite: null, // who has been invited to this project via email
        invite_requests: null, // who has requested to be invited
        deleted: null,
        host: null,
        settings: DEFAULT_QUOTAS,
        site_license: null,
        status: null,
        state: null,
        last_edited: null,
        last_active: null,
        action_request: null, // last requested action -- {action:?, time:?, started:?, finished:?, err:?}
        course: null,
        compute_image: DEFAULT_COMPUTE_IMAGE,
        addons: null
      }
    },
    set: {
      fields: {
        project_id: "project_write",
        title: true,
        description: true,
        deleted: true,
        invite_requests: true, // project collabs can modify this (e.g., to remove from it once user added or rejected)
        users(obj, db, account_id) {
          return db._user_set_query_project_users(obj, account_id);
        },
        action_request: true, // used to request that an action be performed, e.g., "save"; handled by before_change
        compute_image: true,
        course: true,
        site_license: true
      },

      before_change(database, old_val, new_val, account_id, cb) {
        database._user_set_query_project_change_before(
          old_val,
          new_val,
          account_id,
          cb
        );
      },

      on_change(database, old_val, new_val, account_id, cb) {
        database._user_set_query_project_change_after(
          old_val,
          new_val,
          account_id,
          cb
        );
      }
    }
  },

  project_query: {
    get: {
      pg_where: [{ "project_id = $::UUID": "project_id" }],
      fields: {
        project_id: null,
        title: null,
        description: null,
        status: null
      }
    },
    set: {
      fields: {
        project_id: "project_id",
        title: true,
        description: true,
        status: true
      }
    }
  }
};

// Same query above, but without the last_edited time constraint.
schema.projects_all = misc.deep_copy(schema.projects);
schema.projects_all.user_query.get.options = [];
schema.projects_all.virtual = "projects";
schema.projects_all.user_query.get.pg_where = ["projects"];

// Table that enables set queries to the course field of a project.  Only
// project owners are allowed to use this table.  The point is that this makes
// it possible for the owner of the project to set things, but not for the
// collaborators to set those things.
// **wARNING:** right now we're not using this since when multiple people add
// students to a course and the 'course' field doesn't get properly set,
// much confusion and misery arises.... and it is very hard to fix.
// In theory a malicous student could not pay via this.  But if they could
// mess with their client, they could easily not pay anyways.
schema.projects_owner = {
  virtual: "projects",
  fields: {
    project_id: true,
    course: true
  },
  user_query: {
    set: {
      fields: {
        project_id: "project_owner",
        course: true
      }
    }
  }
};

// Table that enables any signed-in user to set an invite request.
// Later: we can make an index so that users can see all outstanding requests they have made easily.
// How to test this from the browser console:
//    project_id = '4e0f5bfd-3f1b-4d7b-9dff-456dcf8725b8' // id of a project you have
//    invite_requests = {}; invite_requests[smc.client.account_id] = {timestamp:new Date(), message:'please invite me'}
//    smc.client.query({cb:console.log, query:{project_invite_requests:{project_id:project_id, invite_requests:invite_requests}}})  // set it
//    smc.redux.getStore('projects').get_project(project_id).invite_requests                 // see requests for this project
//
// CURRENTLY NOT USED.
schema.project_invite_requests = {
  virtual: "projects",
  primary_key: "project_id",
  fields: {
    project_id: true,
    invite_requests: true
  }, // {account_id:{timestamp:?, message:?}, ...}
  user_query: {
    set: {
      fields: {
        project_id: true,
        invite_requests: true
      },
      before_change(_database, _old_val, _new_val, _account_id, cb) {
        cb();
      }
    }
  } // actual function will be database._user... as below.
};
//database._user_set_query_project_invite_requests(old_val, new_val, account_id, cb)
// For now don't check anything -- this is how we will make it secure later.
// This will:
//   - that user setting this is signed in
//   - ensure user only modifies their own entry (for their own id).
//   - enforce some hard limit on number of outstanding invites (say 30).
//   - enforce limit on size of invite message.
//   - sanity check on timestamp
//   - with an index as mentioned above we could limit the number of projects
//     to which a single user has requested to be invited.

// Table that provides extended read info about a single project
// but *ONLY* for admin.
schema.projects_admin = {
  primary_key: schema.projects.primary_key,
  virtual: "projects",
  fields: schema.projects.fields,
  user_query: {
    get: {
      admin: true, // only admins can do get queries on this table
      // (without this, users who have read access could read)
      pg_where: [{ "project_id = $::UUID": "project_id" }],
      fields: schema.projects.user_query.get.fields
    }
  }
};

// Get publicly available information about a project.
//
schema.public_projects = {
  anonymous: true,
  virtual: "projects",
  user_query: {
    get: {
      pg_where: [{ "project_id = $::UUID": "project_id-public" }],
      fields: {
        project_id: true,
        title: true,
        description: true
      }
    }
  }
};

schema.public_paths = {
  primary_key: "id",
  db_standby: "unsafe",
  anonymous: true, // allow user *read* access, even if not signed in
  fields: {
    id: {
      type: "string",
      pg_type: "CHAR(40)",
      desc: "sha1 hash derived from project_id and path"
    },
    project_id: {
      type: "uuid"
    },
    path: {
      type: "string"
    },
    description: {
      type: "string"
    },
    disabled: {
      type: "boolean",
      desc: "if true then disabled"
    },
    unlisted: {
      type: "boolean",
      desc: "if true then unlisted, so does not appear in /share listing page."
    },
    license: {
      type: "string",
      desc: "The license that the content of the share is made available under."
    },
    created: {
      type: "timestamp",
      desc: "when this path was created"
    },
    last_edited: {
      type: "timestamp",
      desc: "when this path was last edited"
    },
    last_saved: {
      type: "timestamp",
      desc:
        "when this path was last saved (or deleted if disabled) by manage-storage"
    },
    counter: {
      type: "number",
      desc: "the number of times this public path has been accessed"
    },
    vhost: {
      // For now, this will only be used *manually* for now; at some point users will be able to specify this,
      // though maybe they have to prove they own it.
      // For now we will only serve the vhost files statically with no special support, except we do support
      // basic http auth.   However, we will add
      // special server support for certain file types (e.g., math typesetting, markdown, sagews, ipynb, etc.)
      // so static websites can just be written in a mix of md, html, ipynb, etc. files with no javascript needed.
      // This could be a non-default option.
      // IMPORTANT: right now if vhost is set, then the share is not visible at all to the normal share server.
      type: "string",
      desc:
        'Request for the given host (which must not container "cocalc") will be served by this public share. Only one public path can have a given vhost.  The vhost field can be a comma-separated string for multiple vhosts.',
      unique: true
    },
    auth: {
      type: "map",
      desc:
        "Map from relative path inside the share to array of {path:[{name:[string], pass:[password-hash]}, ...], ...}.  Used both by vhost and share server, but not user editable yet.  Later it will be user editable.  The password hash is from smc-hub/auth.password_hash (so 1000 iterations of sha512)"
    },
    token: {
      type: "string",
      desc:
        "Random token that must be passed in as query parameter to see this share; this increases security.  Only used for unlisted shares."
    }
  },

  pg_indexes: [
    "project_id",
    "(substring(project_id::text from 1 for 1))",
    "(substring(project_id::text from 1 for 2))"
  ],

  user_query: {
    get: {
      pg_where: [{ "project_id = $::UUID": "project_id" }],
      throttle_changes: 2000,
      fields: {
        id: null,
        project_id: null,
        path: null,
        description: null,
        disabled: null, // if true then disabled
        unlisted: null, // if true then do not show in main listing (so doesn't get google indexed)
        license: null,
        last_edited: null,
        created: null,
        last_saved: null,
        counter: null
      }
    },
    set: {
      fields: {
        id(obj, db) {
          return db.sha1(obj.project_id, obj.path);
        },
        project_id: "project_write",
        path: true,
        description: true,
        disabled: true,
        unlisted: true,
        license: true,
        last_edited: true,
        created: true
      },
      required_fields: {
        id: true,
        project_id: true,
        path: true
      }
    }
  }
};

schema.public_paths.project_query = misc.deep_copy(
  schema.public_paths.user_query
);

/* Look up a single public path by its id. */

schema.public_paths_by_id = {
  anonymous: true,
  virtual: "public_paths",
  user_query: {
    get: {
      check_hook(_db, obj, _account_id, _project_id, cb): void {
        if (typeof obj.id == "string" && obj.id.length == 40) {
          cb(); // good
        } else {
          cb("id must be a sha1 hash");
        }
      },
      fields: {
        id: null,
        project_id: null,
        path: null,
        description: null,
        disabled: null, // if true then disabled
        unlisted: null, // if true then do not show in main listing (so doesn't get google indexed)
        license: null,
        last_edited: null,
        created: null,
        last_saved: null,
        counter: null
      }
    }
  }
};

/*
Requests and status related to copying files between projects.
*/
schema.copy_paths = {
  primary_key: "id",
  fields: {
    id: {
      type: "uuid",
      desc: "random unique id assigned to this copy request"
    },
    time: {
      type: "timestamp",
      desc: "when this request was made"
    },
    source_project_id: {
      type: "uuid",
      desc: "the project_id of the source project"
    },
    source_path: {
      type: "string",
      desc: "the path of the source file or directory"
    },
    target_project_id: {
      type: "uuid",
      desc: "the project_id of the target project"
    },
    target_path: {
      type: "string",
      desc: "the path of the target file or directory"
    },
    overwrite_newer: {
      type: "boolean",
      desc: "if new, overwrite newer files in destination"
    },
    delete_missing: {
      type: "boolean",
      desc: "if true, delete files in the target that aren't in the source path"
    },
    backup: {
      type: "boolean",
      desc: "if true, make backup of files before overwriting"
    },
    public: {
      type: "boolean",
      desc:
        "if true, use files from the public share server instead of starting up the project"
    },
    bwlimit: {
      type: "string",
      desc:
        "optional limit on the bandwidth dedicated to this copy (passed to rsync)"
    },
    timeout: {
      type: "number",
      desc:
        "fail if the transfer itself takes longer than this number of seconds (passed to rsync)"
    },
    scheduled: {
      type: "timestamp",
      desc:
        "earliest time in the future, when the copy request should start (or null, for immediate execution)"
    },
    started: {
      type: "timestamp",
      desc: "when the copy request actually started running"
    },
    finished: {
      type: "timestamp",
      desc: "when the copy request finished"
    },
    error: {
      type: "string",
      desc: "if the copy failed or output any errors, they are put here."
    }
  },
  pg_indexes: [
    "time",
    "scheduled",
    "((started IS NULL))",
    "((finished IS NULL))"
  ]
};
// TODO: for now there are no user queries -- this is used entirely by backend servers,
// actually only in kucalc; later that may change, so the user can make copy
// requests this way, check on their status, show all current copies they are
// causing in a page (that is persistent over browser refreshes, etc.).
// That's for later.

schema.remember_me = {
  primary_key: "hash",
  durability: "soft", // dropping this would just require a user to login again
  fields: {
    hash: {
      type: "string",
      pg_type: "CHAR(127)"
    },
    value: {
      type: "map"
    },
    account_id: {
      type: "uuid"
    },
    expire: {
      type: "timestamp"
    }
  },
  pg_indexes: ["account_id"]
};

schema.auth_tokens = {
  primary_key: "auth_token",
  fields: {
    auth_token: {
      type: "string",
      pg_type: "CHAR(24)"
    },
    account_id: {
      type: "uuid"
    },
    expire: {
      type: "timestamp"
    }
  }
};

schema.server_settings = {
  primary_key: "name",
  anonymous: false,
  fields: {
    name: {
      type: "string"
    },
    value: {
      type: "string"
    }
  },
  user_query: {
    // NOTE: can *set* but cannot get!
    set: {
      admin: true,
      fields: {
        name: null,
        value: null
      }
    }
  }
};

const site_settings_fields = misc
  .keys(site_settings_conf)
  .concat(misc.keys(site_settings_extras));

schema.site_settings = {
  virtual: "server_settings",
  anonymous: false,
  user_query: {
    // NOTE: can set and get only fields in site_settings_fields, but not any others.
    get: {
      pg_where: [{ "name = ANY($)": site_settings_fields }],
      admin: true,
      fields: {
        name: null,
        value: null
      }
    },
    set: {
      admin: true,
      fields: {
        name(obj, _db) {
          if (site_settings_fields.includes(obj.name)) {
            return obj.name;
          }
          throw Error(`setting name='${obj.name}' not allowed`);
        },
        value: null
      }
    }
  }
};

schema.stats = {
  primary_key: "id",
  durability: "soft", // ephemeral stats whose slight loss wouldn't matter much
  anonymous: false, // if true, this would allow user read access, even if not signed in -- we used to do this but decided to use polling instead, since update interval is predictable.
  fields: {
    id: {
      type: "uuid"
    },
    time: {
      type: "timestamp",
      pg_check: "NOT NULL"
    },
    accounts: {
      type: "integer",
      pg_check: "NOT NULL CHECK (accounts >= 0)"
    },
    accounts_created: {
      type: "map"
    },
    files_opened: {
      type: "map"
    },
    projects: {
      type: "integer",
      pg_check: "NOT NULL CHECK (projects >= 0)"
    },
    projects_created: {
      type: "map"
    },
    projects_edited: {
      type: "map"
    },
    hub_servers: {
      type: "array",
      pg_type: "JSONB[]"
    }
  },
  pg_indexes: ["time"]
};

schema.storage_servers = {
  primary_key: "host",
  fields: {
    host: {
      type: "string",
      desc: "hostname of the storage server",
      pg_type: "VARCHAR(63)"
    }
  }
};

schema.system_notifications = {
  primary_key: "id",
  db_standby: "unsafe",
  anonymous: true, // allow users read access, even if not signed in
  fields: {
    id: {
      type: "uuid",
      desc: "primary key"
    },
    time: {
      type: "timestamp",
      desc: "time of this message"
    },
    text: {
      type: "string",
      desc: "the text of the message"
    },
    priority: {
      type: "string",
      pg_type: "VARCHAR(6)",
      desc: 'one of "low", "medium", or "high"'
    },
    done: {
      type: "boolean",
      desc: "if true, then this notification is no longer relevant"
    }
  },
  user_query: {
    get: {
      pg_where: ["time >= NOW() - INTERVAL '1 hour'"],
      pg_changefeed: "one-hour",
      throttle_changes: 3000,
      fields: {
        id: null,
        time: null,
        text: "",
        priority: "low",
        done: false
      }
    },
    set: {
      admin: true,
      fields: {
        id: true,
        time: true,
        text: true,
        priority: true,
        done: true
      }
    }
  }
};

schema.mentions = {
  primary_key: ["time", "project_id", "path", "target"],
  db_standby: "unsafe",
  fields: {
    time: {
      type: "timestamp",
      desc: "when this mention happened."
    },
    project_id: {
      type: "uuid"
    },
    path: {
      type: "string"
    },
    source: {
      type: "uuid",
      desc: "User who did the mentioning."
    },
    target: {
      type: "string",
      desc:
        "uuid of user who was mentioned; later will have other possibilities including group names, 'all', etc."
    },
    description: {
      type: "string",
      desc:
        "Extra text to describe the mention. eg. could be the containing message"
    },
    priority: {
      type: "number",
      desc:
        "optional integer priority.  0 = default, but could be 1 = higher priority, etc."
    },
    error: {
      type: "string",
      desc: "some sort of error occured handling this mention"
    },
    action: {
      type: "string",
      desc: "what action was attempted by the backend - 'email', 'ignore'"
    },
    users: {
      type: "map",
      desc: "{account_id1: {read: boolean, saved: boolean}, account_id2: {...}}"
    }
  },

  pg_indexes: ["action"],

  user_query: {
    get: {
      pg_where: ["time >= NOW() - interval '14 days'", "projects"],
      pg_changefeed: "projects",
      options: [{ order_by: "-time" }, { limit: 100 }], // limit is arbitrary
      throttle_changes: 3000,
      fields: {
        time: null,
        project_id: null,
        path: null,
        source: null,
        target: null,
        priority: null,
        description: null,
        users: null
      }
    },
    set: {
      fields: {
        time({ time }) {
          return time || new Date();
        },
        project_id: "project_write",
        path: true,
        source: true,
        target: true,
        priority: true,
        description: true,
        users: true
      },
      required_fields: {
        project_id: true,
        source: true,
        path: true,
        target: true
      }
    }
  }
};

// Tracking web-analytics
// this records data about users hitting cocalc and cocalc-related websites
// this table is 100% back-end only
schema.analytics = {
  primary_key: ["token"],
  pg_indexes: ["token", "data_time"],
  durability: "soft",
  fields: {
    token: {
      type: "uuid"
    },
    data: {
      type: "map",
      desc: "referrer, landing page, utm, etc."
    },
    data_time: {
      type: "timestamp",
      desc: "when the data field was set"
    },
    account_id: {
      type: "uuid",
      desc: "set only once, when the user (eventually) signs in"
    },
    account_id_time: {
      type: "timestamp",
      desc: "when the account id was set"
    }
  }
};

// what software environments there are available
schema.compute_images = {
  primary_key: ["id"],
  anonymous: true,
  fields: {
    id: {
      type: "string",
      desc: "docker image 'name:tag', where tag defaults to 'latest'"
    },
    src: {
      type: "string",
      desc: "source of the image (likely https://github [...] .git)"
    },
    type: {
      type: "string",
      desc: "for now, this is either 'legacy' or 'custom'"
    },
    display: {
      type: "string",
      desc: "(optional) user-visible name (defaults to id)"
    },
    url: {
      type: "string",
      desc: "(optional) where the user can learn more about it"
    },
    desc: {
      type: "string",
      desc: "(optional) markdown text to talk more about this"
    },
    path: {
      type: "string",
      desc:
        "(optional) point user to either a filename like index.ipynb or a directory/"
    },
    disabled: {
      type: "boolean",
      desc: "(optional) if set and true, do not offer as a selection"
    }
  },
  user_query: {
    get: {
      throttle_changes: 30000,
      pg_where: [],
      fields: {
        id: null,
        src: null,
        type: null,
        display: null,
        url: null,
        desc: null,
        path: null,
        disabled: null
      }
    }
  }
};

// Table for tracking events related to a particular
// account which help us optimize for growth.
// Example entry;
//  account_id: 'some uuid'
//  time: a timestamp
//  key: 'sign_up_how_find_cocalc'
//  value: 'via a google search'
//
// Or if user got to cocalc via a chat mention link:
//
//  account_id: 'some uuid'
//  time: a timestamp
//  key: 'mention'
//  value: 'url of a chat file'
//
// The user cannot read or write directly to this table.
// Writes are done via an API call, which (in theory can)
// enforces some limit (to avoid abuse) at some point...
schema.user_tracking = {
  primary_key: ["account_id", "time"],
  pg_indexes: ["event", "time"],
  durability: "soft",
  fields: {
    account_id: {
      type: "uuid",
      desc: "id of the user's account"
    },
    time: {
      type: "timestamp",
      desc: "time of this message"
    },
    event: {
      type: "string",
      desc: "event we are tracking",
      pg_check: "NOT NULL"
    },
    value: {
      type: "map",
      desc: "optional further info about the event (as a map)"
    }
  }
};
