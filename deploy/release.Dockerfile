FROM scratch
COPY release.json /release.json
# The updater copies JSON from a stopped container. This image is never executed.
CMD ["/not-an-executable"]
