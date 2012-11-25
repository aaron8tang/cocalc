###
#
# Library for working with JSON messages for Salvus.
#
# (c) 2012, William Stein
#
# We use functions to work with messages to ensure some level of
# consistency, defaults, and avoid errors from typos, etc.
#
###
#

misc     = require('misc')
defaults = misc.defaults
required = defaults.required


message = (obj) ->
    exports[obj.event] = (opts={}) ->
        if opts.event?
            throw "ValueError: must not define 'event' when calling message creation function (opts=#{JSON.stringify(opts)}, obj=#{JSON.stringify(obj)})"
        defaults(opts, obj)

############################################
# Sage session management; executing code
#############################################

# hub --> sage_server and browser --> hub
message(
    event        : 'start_session'
    id           : undefined
    limits       : undefined
)

# hub --> browser
message(
    event        : 'session_started'
    id           : required
    session_uuid : undefined
    limits       : undefined
)

# sage_server --> hub
message(
    event  : 'session_description'
    pid    : required
    limits : undefined
)

# browser --> hub --> sage_server
message(
    event        : 'send_signal'
    session_uuid : undefined   # from browser-->hub this must be set
    pid          : undefined   # from hub-->sage_server this must be set
    signal       : 2           # 2 = SIGINT, 3 = SIGQUIT, 9 = SIGKILL
)

# browser <----> hub <--> sage_server
message(
    event        : 'terminate_session'
    session_uuid : undefined
    reason       : undefined
    done         : true
)

# browser --> hub --> sage_server
message(
    event        : 'execute_code'
    id           : undefined
    code         : required
    session_uuid : undefined
    preparse     : true
    allow_cache  : true
)

# sage_server --> hub_i --> hub_j --> browser
message(
    event        : 'output'
    id           : undefined
    stdout       : undefined
    stderr       : undefined
    done         : false
    session_uuid : undefined
)

############################################
# Session Introspection
#############################################
# An introspect message from the client can result in numerous types
# of responses (but there will only be one response).  The id of the
# message from hub back to client will match the id of the message
# from client to hub; the client is responsible for deciding
# what/where/how to deal with the message.

# client --> hub
message
    event              : 'introspect'
    id                 : undefined
    text_before_cursor : required       # text before the cursor
    text_after_cursor  : undefined      # optional text after the cursor

# hub --> client (can be sent in response to introspect message)
message
    event       : 'introspection_completions'
    id          : undefined   # match id of 'introspect' message
    completions : required    # a list of strings (no HTML)

# hub --> client  (can be sent in response to introspect message)
message
    event       : 'introspection_docstring'
    id          : undefined
    docstring   : required    # a string (no HTML), probably formatted using Sphinx/REST

# hub --> client
message
    event       : 'introspection_source'
    id          : undefined
    docstring   : required    # a string



############################################
# Ping/pong
#############################################
# browser --> hub
message(
    event   : 'ping'
    id      : undefined
)

# hub --> browser;   sent in response to a ping
message(
    event   : 'pong'
    id      : undefined
)

############################################
# Account Management
#############################################

# client --> hub
message(
    event          : 'create_account'
    id             : undefined
    first_name     : required
    last_name      : required
    email_address  : required
    password       : required
    agreed_to_terms: required
)

# hub --> client
message (
    event          : 'account_creation_failed'
    id             : required
    reason         : required
)

# client <--> hub
message(
    event          : 'email_address_availability'
    id             : undefined
    email_address  : required
    is_available   : undefined
)

# client --> hub
message(
    id             : undefined
    event          : 'sign_in'
    email_address  : required
    password       : required
    remember_me    : false
)

# client --> hub
message(
    id             : undefined
    event          : 'sign_in_failed'
    email_address  : required
    reason         : required
)

# hub --> client; sent in response to either create_account or log_in
message(
    event          : 'signed_in'
    id             : undefined     # message uuid
    account_id     : required      # uuid of user's account
    first_name     : required      # user's first name
    last_name      : required      # user's last name
    email_address  : required      # address they just signed in using
    remember_me    : required      # true if sign in accomplished via remember_me cookie; otherwise, false.
)


# client --> hub
message(
    event          : 'sign_out'
    id             : undefined
)

# hub --> client
message(
    event          : 'signed_out'
    id             : undefined
)


# client --> hub
message(
    event          : 'change_password'
    id             : undefined
    email_address  : required
    old_password   : required
    new_password   : required
)


# hub --> client
# if error is true, that means the password was not changed; would
# happen if password is wrong (message:'invalid password').
message(
    event          : 'changed_password'
    id             : undefined
    error          : undefined
)

# client --> hub: "please send a password reset email"
message
    event         : "forgot_password"
    id            : undefined
    email_address : required

# hub --> client  "a password reset email was sent, or there was an error"
message
    event         : "forgot_password_response"
    id            : undefined
    error         : false

# client --> hub: "reset a password using this id code that was sent in a password reset email"
message
    event         : "reset_forgot_password"
    id            : undefined
    reset_code    : required
    new_password  : required

message
    event         : "reset_forgot_password_response"
    id            : undefined
    error         : false

# client --> hub
message(
    event             : 'change_email_address'
    id                : undefined
    account_id        : required
    old_email_address : required
    new_email_address : required
    password          : required
)

# hub --> client
message(
    event               : 'changed_email_address'
    id                  : undefined
    error               : false  # some other error
    ttl                 : undefined   # if user is trying to change password too often, this is time to wait
)


############################################
# Account Settings
#############################################

# client --> hub
message(
    event          : "get_account_settings"
    id             : undefined
    account_id     : required
)

# settings that require the password in the message (so user must
# explicitly retype password to change these):
exports.restricted_account_settings =
    plan_id              : undefined
    plan_name            : undefined
    plan_starttime       : undefined
    storage_limit        : undefined
    session_limit        : undefined
    max_session_time     : undefined
    ram_limit            : undefined
    support_level        : undefined
    email_address        : undefined
    connect_Github       : undefined
    connect_Google       : undefined
    connect_Dropbox      : undefined

# these can be changed without additional re-typing of the password
# (of course, user must have somehow logged in):
exports.unrestricted_account_settings =
    first_name           : required
    last_name            : required
    default_system       : required
    evaluate_key         : required
    email_new_features   : required
    email_maintenance    : required
    enable_tooltips      : required

exports.account_settings_defaults =
    plan_id            : 0  # the free trial plan
    default_system     : 'sage'
    evaluate_key       : 'shift-enter'
    email_new_features : true
    email_maintenance  : true
    enable_tooltips    : true
    connect_Github     : ''
    connect_Google     : ''
    connect_Dropbox    : ''

# client <--> hub
message(
    misc.merge({},
        event                : "account_settings"
        account_id           : required
        id                   : undefined
        password             : undefined   # only set when sending message from client to hub; must be set to change restricted settings
        exports.unrestricted_account_settings,
        exports.restricted_account_settings
    )
)

message
    event : "account_settings_saved"
    id    : undefined

message
    event : "error"
    id    : undefined
    error : undefined

message
    event : "success"
    id    : undefined

############################################
# User Feedback
#############################################

message
    event       : 'report_feedback'
    id          : undefined
    category    : required            # 'bug', 'idea', 'comment'
    description : required            # text
    nps         : undefined           # net promotor score; integer 1,2,...,9

message
    event       : 'feedback_reported'
    error       : undefined
    id          : required

message
    event       : 'get_all_feedback_from_user'
    error       : undefined
    id          : undefined

message
    event       : 'all_feedback_from_user'
    id          : required
    error       : undefined
    data        : required  # JSON list of objects


######################################################################################
# This is a message that goes
#      hub --> client
# In response, the client grabs "/cookies?id=...,set=...,get=..." via an AJAX call.
# During that call the server can get/set HTTP-only cookies.
######################################################################################
message
    event       : 'cookies'
    id          : required
    set         : undefined  # name of a cookie to set
    get         : undefined  # name of a cookie to get



############################################
# Projects
#############################################


# client --> hub
message
    event      : 'create_project'
    id         : undefined
    title      : required
    description: required
    public     : required

# hub --> client
message
    event      : 'project_created'
    id         : required
    project_id : required

# client --> hub
message
    event      : 'get_projects'
    id         : undefined

# hub --> client
message
    event      : 'all_projects'
    id         : required
    projects   : required     # [{project_id:, type: , title:, last_edited:}, ...]


# client --> hub
message
    event      : 'update_project_data'
    id         : undefined
    project_id : required
    data       : required     # an object; sets the fields in this object, and leaves alone the rest

# hub --> client
#
# When project data is changed by one client, the following is sent to
# all clients that have access to this project (owner or collaborator).
#
message
    event      : 'project_data_updated'
    id         : undefined
    project_id : required



# hub --> client(s)
message
    event      : 'project_list_updated'

